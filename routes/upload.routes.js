import { Router } from 'express';
import { verifySession } from '../middleware/auth.js';
import { uploadMultiple } from '../middleware/upload.js';
import { uploadImage, uploadFile } from '../services/upload.service.js';

const router = Router();

// Upload files (images and PDFs)
router.post('/upload', verifySession, uploadMultiple, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const uploadedFiles = [];

    for (const file of req.files) {
      const isImage = file.mimetype.startsWith('image/');
      const isPDF = file.mimetype === 'application/pdf';

      let result;
      if (isImage) {
        result = await uploadImage(file.buffer, 'posts/images');
        uploadedFiles.push({
          type: 'image',
          url: result.secure_url,
          name: file.originalname,
          size: file.size,
          publicId: result.public_id,
        });
      } else if (isPDF) {
        result = await uploadFile(file.buffer, 'posts/files', file.originalname);
        uploadedFiles.push({
          type: 'file',
          url: result.secure_url,
          name: file.originalname,
          size: file.size,
          publicId: result.public_id,
        });
      } else {
        // Skip unsupported file types (shouldn't happen due to multer filter)
        continue;
      }
    }

    res.json({
      ok: true,
      files: uploadedFiles,
    });
  } catch (error) {
    console.error('Error uploading files:', error);
    res.status(500).json({ error: 'Failed to upload files', details: error.message });
  }
});

export default router;

