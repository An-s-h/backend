import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import s3Client, { s3Config } from '../config/s3.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

/**
 * Generate a unique file key for S3
 * @param {string} folder - Folder path in S3
 * @param {string} originalName - Original file name
 * @returns {string} - Unique file key
 */
function generateFileKey(folder, originalName) {
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);
  const uniqueId = uuidv4();
  return `${folder}/${baseName}-${uniqueId}${ext}`;
}

/**
 * Get the public URL for an S3 object
 * @param {string} key - S3 object key
 * @returns {string} - Public URL
 */
function getPublicUrl(key) {
  const bucket = s3Config.bucket;
  const region = s3Config.region;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Upload image to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} folder - Folder path in S3 (e.g., 'posts/images')
 * @param {string} originalName - Original file name
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<Object>} - Upload result with url, key, etc.
 */
export async function uploadImage(fileBuffer, folder = 'posts/images', originalName = 'image', mimetype = 'image/jpeg') {
  try {
    const key = generateFileKey(folder, originalName);

    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimetype,
      // Note: For public access, configure your S3 bucket policy to allow public read access
      // ACL is deprecated in newer S3 buckets - use bucket policies instead
    });

    await s3Client.send(command);

    const url = getPublicUrl(key);

    return {
      url,
      secure_url: url, // For backward compatibility
      key,
      public_id: key, // For backward compatibility
      bucket: s3Config.bucket,
    };
  } catch (error) {
    console.error('Error uploading image to S3:', error);
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

/**
 * Upload PDF or other file to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} folder - Folder path in S3 (e.g., 'posts/files')
 * @param {string} originalName - Original file name
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<Object>} - Upload result with url, key, etc.
 */
export async function uploadFile(fileBuffer, folder = 'posts/files', originalName = 'file', mimetype = 'application/octet-stream') {
  try {
    const key = generateFileKey(folder, originalName);

    const command = new PutObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: mimetype,
      // Note: For public access, configure your S3 bucket policy to allow public read access
      // ACL is deprecated in newer S3 buckets - use bucket policies instead
    });

    await s3Client.send(command);

    const url = getPublicUrl(key);

    return {
      url,
      secure_url: url, // For backward compatibility
      key,
      public_id: key, // For backward compatibility
      bucket: s3Config.bucket,
    };
  } catch (error) {
    console.error('Error uploading file to S3:', error);
    throw new Error(`Failed to upload file: ${error.message}`);
  }
}

/**
 * Delete file from S3
 * @param {string} key - S3 object key (or public_id for backward compatibility)
 * @param {string} resourceType - Not used for S3, kept for backward compatibility
 * @returns {Promise<Object>} - Deletion result
 */
export async function deleteFile(key, resourceType = 'image') {
  try {
    const command = new DeleteObjectCommand({
      Bucket: s3Config.bucket,
      Key: key,
    });

    await s3Client.send(command);

    return {
      result: 'ok',
      message: 'File deleted successfully',
    };
  } catch (error) {
    console.error('Error deleting file from S3:', error);
    throw new Error(`Failed to delete file: ${error.message}`);
  }
}
