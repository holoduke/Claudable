/**
 * Optional BACKEND stacks a project can be composed with (alongside the frontend
 * stack in stacks.ts). Each defines a starter scaffold — a minimal server + a
 * Dockerfile — that runs as its OWN isolated container with its own preview URL
 * ("model B"); the frontend calls it via an injected API base URL. The agent
 * fleshes the starter out. Stored on the project's `settings.backendType`.
 */
export type BackendKind = 'node' | 'go' | 'python';

export interface BackendStack {
  id: BackendKind;
  name: string;
  description: string;
  /** Port the server listens on inside its container (published + proxied to). */
  port: number;
  /** Files written under the project to scaffold the backend. Keyed by relative path. */
  files: (ctx: { corsOrigin: string }) => Record<string, string>;
}

const GO_MAIN = `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

// Minimal Go backend. The agent builds this out; every route lives under /api.
func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/api/hello", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"message": "Hello from the Go backend"})
	})

	addr := ":" + env("PORT", "8080")
	log.Printf("backend listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, cors(mux)))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// CORS so the frontend (served from its own preview URL) can call this backend.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", env("CORS_ORIGIN", "*"))
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
`;

const GO_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY backend/go.mod ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -o /out/server .

FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /out/server /app/server
USER app
EXPOSE 8080
ENTRYPOINT ["/app/server"]
`;

const NODE_INDEX = `import express from 'express';
import cors from 'cors';

// Minimal Node/Express backend. The agent builds this out; routes live under /api.
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/hello', (_req, res) => res.json({ message: 'Hello from the Node backend' }));

const port = Number(process.env.PORT) || 8080;
app.listen(port, '0.0.0.0', () => console.log('backend listening on ' + port));
`;

const NODE_PACKAGE = `{
  "name": "backend",
  "private": true,
  "type": "module",
  "scripts": { "start": "node index.js" },
  "dependencies": { "express": "^4.21.2", "cors": "^2.8.5" }
}
`;

const NODE_DOCKERFILE = `FROM node:22-bookworm-slim
RUN useradd -m -u 10001 app
WORKDIR /app
COPY backend/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ ./
USER app
EXPOSE 8080
CMD ["node", "index.js"]
`;

const PY_MAIN = `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

# Minimal FastAPI backend. The agent builds this out; routes live under /api.
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("CORS_ORIGIN", "*")],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/hello")
def hello():
    return {"message": "Hello from the Python backend"}
`;

const PY_REQS = `fastapi==0.115.6
uvicorn[standard]==0.34.0
`;

const PY_DOCKERFILE = `FROM python:3.12-slim
RUN useradd -m -u 10001 app
WORKDIR /app
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
USER app
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port \${PORT:-8080}"]
`;

export const BACKEND_STACKS: BackendStack[] = [
  {
    id: 'node',
    name: 'Node.js (Express)',
    description: 'A minimal Express server exposing /api — pairs naturally with the JS frontends.',
    port: 8080,
    files: () => ({
      'backend/index.js': NODE_INDEX,
      'backend/package.json': NODE_PACKAGE,
      'backend/Dockerfile': NODE_DOCKERFILE,
    }),
  },
  {
    id: 'go',
    name: 'Go',
    description: 'A minimal Go net/http server — fast, single static binary.',
    port: 8080,
    files: () => ({
      'backend/main.go': GO_MAIN,
      'backend/go.mod': 'module backend\n\ngo 1.25\n',
      'backend/Dockerfile': GO_DOCKERFILE,
    }),
  },
  {
    id: 'python',
    name: 'Python (FastAPI)',
    description: 'A minimal FastAPI server with uvicorn.',
    port: 8080,
    files: () => ({
      'backend/main.py': PY_MAIN,
      'backend/requirements.txt': PY_REQS,
      'backend/Dockerfile': PY_DOCKERFILE,
    }),
  },
];

export function isValidBackend(id: string | null | undefined): id is BackendKind {
  return !!id && BACKEND_STACKS.some((b) => b.id === id);
}
export function getBackendStack(id: string | null | undefined): BackendStack | undefined {
  return BACKEND_STACKS.find((b) => b.id === id);
}
