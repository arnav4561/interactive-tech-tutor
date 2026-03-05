import { createHash } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const TABLE_PREFIX = process.env.DYNAMODB_TABLE_PREFIX?.trim() || "itt";
const SESSIONS_TABLE = `${TABLE_PREFIX}-sessions`;
const hasAwsCredentials = Boolean(
  process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim()
);
const dynamoClient = hasAwsCredentials
  ? new DynamoDBClient({
      region: process.env.AWS_REGION?.trim() || "us-east-1",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    })
  : null;
const docClient = dynamoClient ? DynamoDBDocumentClient.from(dynamoClient) : null;

interface TokenPayload {
  userId: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  auth?: TokenPayload;
}

export function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

export function createToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header." });
    return;
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    if (docClient) {
      const session = await docClient.send(
        new GetCommand({
          TableName: SESSIONS_TABLE,
          Key: { sessionToken: token }
        })
      );
      if (!session.Item) {
        res.status(401).json({ error: "Session is invalid or expired." });
        return;
      }
      const expiresAt = String((session.Item as Record<string, unknown>).expiresAt ?? "");
      if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
        res.status(401).json({ error: "Session is invalid or expired." });
        return;
      }
    }
    req.auth = payload;
    next();
  } catch (_error) {
    res.status(401).json({ error: "Token invalid or expired." });
  }
}
