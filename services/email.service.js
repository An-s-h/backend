import nodemailer from "nodemailer";

// Create reusable transporter using Gmail SMTP
const createTransporter = () => {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD, // Use App Password, not regular password
    },
  });
};

/**
 * Send verification email to user
 * @param {string} email - Recipient email address
 * @param {string} username - Recipient username
 * @param {string} verificationToken - Email verification token
 * @param {string} otp - 6-digit OTP code
 * @returns {Promise<Object>} - Result of sending email
 */
export async function sendVerificationEmail(
  email,
  username,
  verificationToken,
  otp
) {
  try {
    const transporter = createTransporter();
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const verificationLink = `${frontendUrl}/verify-email?token=${verificationToken}`;

    // Logo URL - configure via environment variable (should be S3 URL)
    const logoUrl = process.env.LOGO_URL || `https://res.cloudinary.com/dtgmjvfms/image/upload/logo_mh2rpv.png`;

    const mailOptions = {
      from: `"Collabiora" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: "Verify Your Collabiora Email Address",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify Your Email</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #D0C4E2, #E8E0EF); padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Collabiora Logo" style="max-width: 200px; height: auto; margin-bottom: 10px;" />
          </div>
          
          <div style="background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #2F3C96;">Hello ${username}!</h2>
            
            <p>Thank you for signing up for Collabiora. Please verify your email address to complete your registration and unlock all features.</p>
            
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
              <p style="color: #333; font-size: 16px; font-weight: bold; margin-bottom: 10px;">Your Verification Code:</p>
              <div style="background: #2F3C96; color: #fff; padding: 15px 30px; border-radius: 8px; display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                ${otp}
              </div>
              <p style="color: #666; font-size: 12px; margin-top: 10px;">This code expires in 15 minutes</p>
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 20px;">Or click the link below to verify:</p>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${verificationLink}" 
                 style="display: inline-block; background: #2F3C96; color: #fff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                Verify Email Address
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
            <p style="color: #666; font-size: 12px; word-break: break-all;">${verificationLink}</p>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
              The verification link will expire in 24 hours. If you didn't create an account with Collabiora, please ignore this email.
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
            <p>&copy; ${new Date().getFullYear()} Collabiora. All rights reserved.</p>
          </div>
        </body>
        </html>
      `,
      text: `
        Hello ${username}!
        
        Thank you for signing up for Collabiora. Please verify your email address.
        
        Your Verification Code: ${otp}
        (This code expires in 15 minutes)
        
        Or click the link below to verify:
        ${verificationLink}
        
        The verification link will expire in 24 hours. If you didn't create an account with Collabiora, please ignore this email.
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log("Verification email sent:", info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error("Error sending verification email:", error);
    throw new Error(`Failed to send verification email: ${error.message}`);
  }
}

/**
 * Verify email transporter configuration
 * @returns {Promise<boolean>} - True if configuration is valid
 */
export async function verifyEmailConfig() {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log("Email server is ready to send messages");
    return true;
  } catch (error) {
    console.error("Email configuration error:", error);
    return false;
  }
}
