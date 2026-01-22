import cloudinary from '../config/cloudinary.js';

/**
 * Upload image to Cloudinary
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} folder - Folder path in Cloudinary
 * @returns {Promise<Object>} - Upload result with url, public_id, etc.
 */
export async function uploadImage(fileBuffer, folder = 'posts/images') {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { 
        folder,
        resource_type: 'image',
        transformation: [
          { quality: 'auto' },
          { fetch_format: 'auto' }
        ]
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    ).end(fileBuffer);
  });
}

/**
 * Upload PDF or other file to Cloudinary
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} folder - Folder path in Cloudinary
 * @param {string} originalName - Original file name
 * @returns {Promise<Object>} - Upload result with url, public_id, etc.
 */
export async function uploadFile(fileBuffer, folder = 'posts/files', originalName = 'file') {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { 
        folder,
        resource_type: 'raw',
        public_id: originalName.replace(/\.[^/.]+$/, ''), // Remove extension
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    ).end(fileBuffer);
  });
}

/**
 * Delete file from Cloudinary
 * @param {string} publicId - Cloudinary public ID
 * @param {string} resourceType - 'image' or 'raw'
 * @returns {Promise<Object>} - Deletion result
 */
export async function deleteFile(publicId, resourceType = 'image') {
  return cloudinary.uploader.destroy(publicId, {
    resource_type: resourceType,
  });
}

