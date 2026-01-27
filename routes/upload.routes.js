import { Router } from 'express';
import { verifySession } from '../middleware/auth.js';
import { uploadMultiple, uploadSingle } from '../middleware/upload.js';
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
        result = await uploadImage(file.buffer, 'posts/images', file.originalname, file.mimetype);
        uploadedFiles.push({
          type: 'image',
          url: result.secure_url,
          name: file.originalname,
          size: file.size,
          publicId: result.public_id,
        });
      } else if (isPDF) {
        result = await uploadFile(file.buffer, 'posts/files', file.originalname, file.mimetype);
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

// Upload profile picture
router.post('/upload/profile-picture', verifySession, uploadSingle, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!req.file.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: 'File must be an image' });
    }

    // Upload to S3 in profile-pictures folder
    const result = await uploadImage(
      req.file.buffer,
      'profile-pictures',
      req.file.originalname,
      req.file.mimetype
    );

    res.json({
      ok: true,
      url: result.url,
      key: result.key,
    });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ error: 'Failed to upload profile picture', details: error.message });
  }
});

export default router;

