# Fly.io worker container (v0.7). Drains job_queue and runs the Claude Agent
# SDK over per-athlete folders. NOT the Next.js web app — that deploys to Vercel.
FROM node:24-slim

# The Agent SDK spawns a native Claude binary; ripgrep backs the built-in Grep
# tool. git is handy for any WebSearch/tooling that shells out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ripgrep git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. npm ci on linux pulls the SDK's
# linux-x64 binary (the thing that didn't fit in a Vercel function).
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker

ENV NODE_ENV=production
ENV ATHLETE_ROOT=/data/athletes

# tsx resolves the tsconfig "@/*" path alias at runtime, so the worker can
# import the shared src/ code the same way the bot scripts do.
CMD ["npx", "tsx", "worker/index.ts"]
