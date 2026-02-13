/**
 * Email service via Unosend API (https://www.unosend.co)
 *
 * Required env:
 *   UNOSEND_API_KEY   - Your Unosend API key (Bearer token)
 *   UNOSEND_FROM_EMAIL - Sender address from a verified domain (e.g. hello@yourdomain.com)
 *                        Fallback: GMAIL_USER if set
 * Optional: FRONTEND_URL, LOGO_URL
 */
const UNOSEND_API_URL = "https://www.unosend.co/api/v1/emails";

/**
 * Send verification email via Unosend API
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
    const apiKey = process.env.UNOSEND_API_KEY;
    const fromEmail = process.env.UNOSEND_FROM_EMAIL || process.env.GMAIL_USER;

    if (!apiKey) {
      throw new Error("UNOSEND_API_KEY is not set in environment");
    }
    if (!fromEmail) {
      throw new Error(
        "UNOSEND_FROM_EMAIL (or GMAIL_USER) is not set - use a verified sending domain"
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const verificationLink = `${frontendUrl}/verify-email?token=${verificationToken}`;

    const logoUrl =
      process.env.LOGO_URL ||
      `https://res.cloudinary.com/dtgmjvfms/image/upload/logo_mh2rpv.png`;

    const html = `
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
      `;

    const response = await fetch(UNOSEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail.includes("<") ? fromEmail : `Collabiora <${fromEmail}>`,
        to: email,
        subject: "Verify Your Collabiora Email Address",
        html,
        // Add plain text version for better deliverability
        text: `Hello ${username}!\n\nThank you for signing up for Collabiora. Please verify your email address to complete your registration and unlock all features.\n\nYour Verification Code: ${otp}\n(This code expires in 15 minutes)\n\nOr verify by clicking this link:\n${verificationLink}\n\nThe verification link will expire in 24 hours. If you didn't create an account with Collabiora, please ignore this email.\n\n© ${new Date().getFullYear()} Collabiora. All rights reserved.`,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMessage = errBody;
      let errorDetails = {};
      try {
        errorDetails = JSON.parse(errBody);
        errMessage = errorDetails.message || errorDetails.error || JSON.stringify(errorDetails);
      } catch (_) {}
      console.error(`Unosend API error (${response.status}):`, errorDetails);
      throw new Error(`Unosend API error (${response.status}): ${errMessage}`);
    }

    const data = await response.json().catch(() => ({}));
    const messageId = data.id || data.messageId || data.message_id;
    console.log("Verification email sent via Unosend:", messageId || "ok");
    return { success: true, messageId: messageId || "sent" };
  } catch (error) {
    console.error("Error sending verification email:", error);
    throw new Error(`Failed to send verification email: ${error.message}`);
  }
}

/**
 * Send password reset email via Unosend API
 * @param {string} email - Recipient email address
 * @param {string} username - Recipient username
 * @param {string} resetToken - Password reset token
 * @param {string} otp - Optional 6-digit OTP code (backup)
 * @returns {Promise<Object>} - Result of sending email
 */
export async function sendPasswordResetEmail(
  email,
  username,
  resetToken
) {
  try {
    const apiKey = process.env.UNOSEND_API_KEY;
    const fromEmail = process.env.UNOSEND_FROM_EMAIL || process.env.GMAIL_USER;

    if (!apiKey) {
      throw new Error("UNOSEND_API_KEY is not set in environment");
    }
    if (!fromEmail) {
      throw new Error(
        "UNOSEND_FROM_EMAIL (or GMAIL_USER) is not set - use a verified sending domain"
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const resetLink = `${frontendUrl}/reset-password?token=${resetToken}`;

    const logoUrl =
      process.env.LOGO_URL ||
      `https://res.cloudinary.com/dtgmjvfms/image/upload/logo_mh2rpv.png`;

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #D0C4E2, #E8E0EF); padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Collabiora Logo" style="max-width: 200px; height: auto; margin-bottom: 10px;" />
          </div>
          
          <div style="background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #2F3C96;">Hello ${username}!</h2>
            
            <p>We received a request to reset your password for your Collabiora account. Click the button below to reset your password.</p>
            
            <div style="text-align: center; margin: 20px 0;">
              <a href="${resetLink}" 
                 style="display: inline-block; background: #2F3C96; color: #fff; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                Reset Password
              </a>
            </div>
            
            <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
            <p style="color: #666; font-size: 12px; word-break: break-all;">${resetLink}</p>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
              <strong>Important:</strong> This link will expire in 15 minutes and can only be used once. If you didn't request a password reset, please ignore this email and your password will remain unchanged.
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
            <p>&copy; ${new Date().getFullYear()} Collabiora. All rights reserved.</p>
          </div>
        </body>
        </html>
      `;

    const response = await fetch(UNOSEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail.includes("<") ? fromEmail : `Collabiora <${fromEmail}>`,
        to: email,
        subject: "Reset Your Collabiora Password",
        html,
        // Add plain text version for better deliverability
        text: `Hello ${username}!\n\nWe received a request to reset your password for your Collabiora account. Click the link below to reset your password:\n\n${resetLink}\n\nIMPORTANT: This link will expire in 15 minutes and can only be used once. If you didn't request a password reset, please ignore this email and your password will remain unchanged.\n\n© ${new Date().getFullYear()} Collabiora. All rights reserved.`,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMessage = errBody;
      let errorDetails = {};
      try {
        errorDetails = JSON.parse(errBody);
        errMessage = errorDetails.message || errorDetails.error || JSON.stringify(errorDetails);
      } catch (_) {}
      console.error(`Unosend API error (${response.status}):`, errorDetails);
      throw new Error(`Unosend API error (${response.status}): ${errMessage}`);
    }

    const data = await response.json().catch(() => ({}));
    const messageId = data.id || data.messageId || data.message_id;
    console.log("Password reset email sent via Unosend:", messageId || "ok");
    return { success: true, messageId: messageId || "sent" };
  } catch (error) {
    console.error("Error sending password reset email:", error);
    throw new Error(`Failed to send password reset email: ${error.message}`);
  }
}

/**
 * Send password reset confirmation email
 * @param {string} email - Recipient email address
 * @param {string} username - Recipient username
 * @returns {Promise<Object>} - Result of sending email
 */
export async function sendPasswordResetConfirmationEmail(email, username) {
  try {
    const apiKey = process.env.UNOSEND_API_KEY;
    const fromEmail = process.env.UNOSEND_FROM_EMAIL || process.env.GMAIL_USER;

    if (!apiKey) {
      throw new Error("UNOSEND_API_KEY is not set in environment");
    }
    if (!fromEmail) {
      throw new Error(
        "UNOSEND_FROM_EMAIL (or GMAIL_USER) is not set - use a verified sending domain"
      );
    }

    const logoUrl =
      process.env.LOGO_URL ||
      `https://res.cloudinary.com/dtgmjvfms/image/upload/logo_mh2rpv.png`;

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Password Changed Successfully</title>
        </head>
        <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #D0C4E2, #E8E0EF); padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 20px;">
            <img src="${logoUrl}" alt="Collabiora Logo" style="max-width: 200px; height: auto; margin-bottom: 10px;" />
          </div>
          
          <div style="background: #fff; padding: 30px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <h2 style="color: #2F3C96;">Hello ${username}!</h2>
            
            <p>Your password was successfully changed on ${new Date().toLocaleString()}.</p>
            
            <p style="color: #666; font-size: 14px; margin-top: 20px;">
              If you didn't make this change, please contact our support team immediately to secure your account.
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 20px; color: #999; font-size: 12px;">
            <p>&copy; ${new Date().getFullYear()} Collabiora. All rights reserved.</p>
          </div>
        </body>
        </html>
      `;

    const response = await fetch(UNOSEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromEmail.includes("<") ? fromEmail : `Collabiora <${fromEmail}>`,
        to: email,
        subject: "Your Password Was Changed Successfully",
        html,
        // Add plain text version for better deliverability
        text: `Hello ${username}!\n\nYour password was successfully changed on ${new Date().toLocaleString()}.\n\nIf you didn't make this change, please contact our support team immediately to secure your account.\n\n© ${new Date().getFullYear()} Collabiora. All rights reserved.`,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMessage = errBody;
      let errorDetails = {};
      try {
        errorDetails = JSON.parse(errBody);
        errMessage = errorDetails.message || errorDetails.error || JSON.stringify(errorDetails);
      } catch (_) {}
      console.error(`Unosend API error (${response.status}):`, errorDetails);
      throw new Error(`Unosend API error (${response.status}): ${errMessage}`);
    }

    const data = await response.json().catch(() => ({}));
    const messageId = data.id || data.messageId || data.message_id;
    console.log("Password reset confirmation email sent via Unosend:", messageId || "ok");
    return { success: true, messageId: messageId || "sent" };
  } catch (error) {
    console.error("Error sending password reset confirmation email:", error);
    throw new Error(`Failed to send confirmation email: ${error.message}`);
  }
}

/**
 * Verify Unosend configuration (API key and from address set)
 * @returns {Promise<boolean>} - True if configuration is valid
 */
export async function verifyEmailConfig() {
  try {
    if (!process.env.UNOSEND_API_KEY) {
      console.error("Email configuration error: UNOSEND_API_KEY is not set");
      return false;
    }
    if (
      !process.env.UNOSEND_FROM_EMAIL &&
      !process.env.GMAIL_USER
    ) {
      console.error(
        "Email configuration error: UNOSEND_FROM_EMAIL (or GMAIL_USER) is not set"
      );
      return false;
    }
    console.log("Unosend email configuration is ready");
    return true;
  } catch (error) {
    console.error("Email configuration error:", error);
    return false;
  }
}
