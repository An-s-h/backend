import multer from 'multer';
import path from 'path';

// Configure multer to store files in memory
const storage = multer.memoryStorage();

// File filter function
const fileFilter = (req, file, cb) => {
  const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  const allowedFileTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

  // Check if it's an image
  if (allowedImageTypes.includes(file.mimetype)) {
    return cb(null, true);
  }

  // Check if it's a PDF or document
  if (allowedFileTypes.includes(file.mimetype)) {
    return cb(null, true);
  }

  // Reject other file types
  cb(new Error('Invalid file type. Only images (JPEG, PNG, GIF, WebP) and PDFs are allowed.'), false);
};

// Configure multer
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Middleware for single file upload
export const uploadSingle = upload.single('file');

// Middleware for multiple file uploads
export const uploadMultiple = upload.array('files', 10); // Max 10 files

