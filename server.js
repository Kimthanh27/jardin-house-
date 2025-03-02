// file: server.js
const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const path    = require('path');
const FormData = require('form-data');

const app = express();
const upload = multer(); // Middleware xử lý multipart/form-data

// Leonardo AI API key (đã điền)
const API_KEY = '378df0a9-bd98-44e3-b51b-716cc1520ec6';
// OpenAI API key cho prompt generator (đã điền)
const OPENAI_API_KEY = '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';

// Middleware cho JSON (dùng cho endpoint /generate-prompt)
app.use(express.json());
// Phục vụ file tĩnh (HTML, CSS, JS) từ thư mục hiện tại
app.use(express.static(path.join(__dirname, './')));

// Endpoint: Generate Prompt using OpenAI Chat API (GPT-4)
app.post('/generate-prompt', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) {
    return res.status(400).json({ error: "Keyword is required." });
  }
  try {
    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `Your task is to receive keywords about house design, then complete them into a full Leonardo AI prompt, keeping it concise within 100 words. Add these suffixes at the end of the prompt: "Photorealistic style, dynamic composition, dramatic lighting, and highly detailed fur texture." Avoid adding titles like "title" or "prompt" before the prompt. Just provide the prompt directly. Use simple English for the prompt.`
          },
          {
            role: "user",
            content: `Keyword: "${keyword}"`
          }
        ],
        temperature: 0.7,
        max_tokens: 150
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        }
      }
    );
    const generatedPrompt = openaiResponse.data.choices &&
                            openaiResponse.data.choices[0].message.content;
    if (!generatedPrompt) {
      return res.status(500).json({ error: "No prompt generated." });
    }
    res.json({ prompt: generatedPrompt.trim() });
  } catch (err) {
    console.error("OpenAI Chat API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate prompt." });
  }
});

// Endpoint: Generate Images using Leonardo AI and then Upscale them
app.post('/generate-upscaled', upload.single('image'), async (req, res) => {
  try {
    // 1. Lấy dữ liệu từ request
    const imageFile = req.file;
    const prompt = req.body.prompt || 'A galaxy over snowy mountains';
    const strength = parseFloat(req.body.strength) || 0.5;
    // Sử dụng model Phoenix 1.0 cố định
    const modelId = 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3';

    if (!imageFile || !prompt) {
      return res.status(400).json({ error: "Thiếu ảnh hoặc prompt." });
    }

    // 2. Gọi API init-image để lấy presigned URL và initImageId
    const ext = path.extname(imageFile.originalname).replace('.', '').toLowerCase() || 'png';
    const initResp = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/init-image',
      { extension: ext },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }
    );
    const uploadInfo = initResp.data.uploadInitImage;
    const initImageId = uploadInfo.id;
    const uploadUrl = uploadInfo.url;
    const fields = JSON.parse(uploadInfo.fields);

    // 3. Upload file ảnh lên presigned URL
    const formData = new FormData();
    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      formData.append(fieldName, fieldValue);
    }
    formData.append('file', imageFile.buffer, { filename: imageFile.originalname });
    await axios.post(uploadUrl, formData, {
      headers: formData.getHeaders()
    });

    // 4. Gọi API /generations để tạo ảnh với model Phoenix 1.0 và tạo 2 ảnh đầu ra
    const generationResp = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/generations',
      {
        prompt: prompt,
        modelId: 'de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3',  // Model Phoenix 1.0
        width: 512,
        height: 512,
        init_image_id: initImageId,
        init_strength: strength,
        num_images: 2
      },
      { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' } }
    );
    // Lấy generationId từ response
    const generationId = generationResp.data.sdGenerationJob?.generationId ||
                         generationResp.data.generationId ||
                         generationResp.data.id ||
                         generationResp.data.generations_by_pk?.id;
    if (!generationId) {
      return res.status(500).json({ error: "Không lấy được generationId." });
    }

    // 5. Thăm dò trạng thái tạo ảnh (polling) đến khi hoàn tất
    let generatedImages = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      const statusResp = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        { headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' } }
      );
      const genData = statusResp.data;
      const status = genData.generations_by_pk?.status || genData.status;
      if (status === 'COMPLETE') {
        generatedImages = genData.generations_by_pk?.generated_images || genData.generated_images || [];
        break;
      } else if (status === 'FAILED') {
        return res.status(500).json({ error: "Generation failed." });
      }
    }
    if (!generatedImages.length) {
      return res.status(500).json({ error: "Tạo ảnh thất bại (timeout)." });
    }

    // 6. Gọi endpoint upscale (POST /variations/universal-upscaler) cho từng ảnh với chế độ CINEMATIC
    const upscaledResults = [];
    for (let i = 0; i < generatedImages.length; i++) {
      const gImg = generatedImages[i];
      const upscalerResp = await axios.post(
        'https://cloud.leonardo.ai/api/rest/v1/variations/universal-upscaler',
        {
          upscalerStyle: "CINEMATIC",
          creativityStrength: 8,
          upscaleMultiplier: 2,
          generatedImageId: gImg.id
        },
        {
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        }
      );
      // Lấy variationId từ kết quả upscale
      const variationId = upscalerResp.data.id || upscalerResp.data.variations_by_pk?.id;
      if (!variationId) {
        upscaledResults.push({ upscaledUrl: null, originalUrl: gImg.url });
        continue;
      }
      // 7. Thăm dò trạng thái upscale cho đến khi hoàn tất (polling)
      let upscaledUrl = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        const varStatusResp = await axios.get(
          `https://cloud.leonardo.ai/api/rest/v1/variations/${variationId}`,
          {
            headers: {
              'Authorization': `Bearer ${API_KEY}`,
              'Accept': 'application/json'
            }
          }
        );
        const varData = varStatusResp.data;
        const varStatus = varData.variations_by_pk?.status || varData.status;
        if (varStatus === 'COMPLETE') {
          const varImages = varData.variations_by_pk?.generated_images || varData.generated_images || [];
          if (varImages.length) {
            upscaledUrl = varImages[0].url;
          }
          break;
        } else if (varStatus === 'FAILED') {
          break;
        }
      }
      upscaledResults.push({
        upscaledUrl: upscaledUrl,
        originalUrl: gImg.url
      });
    }

    // 8. Trả về kết quả: mảng URL ảnh gốc và mảng kết quả upscale
    res.json({
      generated: generatedImages.map(x => x.url),
      upscaled: upscaledResults
    });

  } catch (err) {
    console.error("Error in /generate-upscaled:", err.response?.data || err.message);
    res.status(500).json({ error: "Lỗi server hoặc API." });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("Server đang chạy tại http://localhost:" + PORT);
});
