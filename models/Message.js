import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    senderRole: { type: String, enum: ["patient", "researcher"], required: true },
    receiverRole: { type: String, enum: ["patient", "researcher"], required: true },
    subject: { type: String, default: "" },
    body: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ receiverId: 1, read: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, receiverId: 1 });
messageSchema.index({ createdAt: -1 });

export const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

