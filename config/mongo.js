import mongoose from "mongoose";

let isConnected = false;

export async function connectMongo() {
  if (isConnected) return;
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI is not set");
  }
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, {
    dbName: process.env.MONGO_DB || "curalink",
  });
  isConnected = true;
  console.log("MongoDB connected");
}


