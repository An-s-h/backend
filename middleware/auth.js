import { User } from "../models/User.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ;

export async function verifySession(req, res, next) {
  const token =
    req.headers["authorization"]?.replace("Bearer ", "") ||
    req.headers["x-auth-token"] ||
    req.query.token ||
    req.body?.token;

  if (!token) {
    return res.status(401).json({ error: "Authentication token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(500).json({ error: "Authentication error" });
  }
}

export async function optionalSession(req, res, next) {
  const token =
    req.headers["authorization"]?.replace("Bearer ", "") ||
    req.headers["x-auth-token"] ||
    req.query.token ||
    req.body?.token;

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      req.user = user || null;
    } catch (error) {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}
