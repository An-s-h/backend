import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, index: true },
    handle: { type: String, sparse: true }, // Unique username/handle for profile URLs
    email: { type: String, required: true, index: true },
    password: { type: String, required: false }, // Optional for OAuth users
    role: { type: String, enum: ["patient", "researcher"], default: "patient" },
    medicalInterests: [{ type: String }], // Conditions for patients, interests for researchers
    nameHidden: { type: Boolean, default: false }, // Hide name from others, show only handle
    age: { type: Number }, // Optional age field

    // OAuth fields
    auth0Id: { type: String, sparse: true }, // Auth0 user ID (sub)
    oauthProvider: { type: String }, // google-oauth2, windowslive, etc.
    picture: { type: String }, // Profile picture URL from OAuth or S3
    emailVerified: { type: Boolean, default: false },
    isOAuthUser: { type: Boolean, default: false },

    // Email verification fields
    emailVerificationToken: { type: String, sparse: true, index: true },
    emailVerificationTokenExpiry: { type: Date },
    lastVerificationEmailSent: { type: Date }, // Track when last verification email was sent
    emailVerificationOTP: { type: String }, // 6-digit OTP for email verification
    emailVerificationOTPExpiry: { type: Date }, // OTP expires in 15 minutes
  },
  { timestamps: true }
);

// Compound index for email + role (same email can be patient AND researcher)
userSchema.index({ email: 1, role: 1 }, { unique: true });

// Index for Auth0 ID lookup
userSchema.index({ auth0Id: 1 }, { sparse: true });

// Unique index for handle (username)
userSchema.index({ handle: 1 }, { unique: true, sparse: true });

// Hash password before saving (only if password exists and is modified)
userSchema.pre("save", async function (next) {
  // Skip hashing if no password (OAuth users) or password not modified
  if (!this.password || !this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  // OAuth users don't have passwords
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

export const User = mongoose.models.User || mongoose.model("User", userSchema);
