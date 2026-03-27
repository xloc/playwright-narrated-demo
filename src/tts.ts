import { execSync } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

export interface TTSProvider {
  name: string;
  ext: string;
  available: () => boolean;
  generate: (text: string, outPath: string) => void;
}

const macSay: TTSProvider = {
  name: "macOS say",
  ext: ".aiff",
  available: () => {
    try {
      execSync("which say", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  },
  generate: (text, outPath) => {
    execSync(`say -o ${outPath} ${JSON.stringify(text)}`);
  },
};

const openai: TTSProvider = {
  name: "OpenAI TTS",
  ext: ".mp3",
  available: () => !!process.env.OPENAI_API_KEY,
  generate: (text, outPath) => {
    execSync(
      `curl -s https://api.openai.com/v1/audio/speech \
        -H "Authorization: Bearer ${process.env.OPENAI_API_KEY}" \
        -H "Content-Type: application/json" \
        -d ${JSON.stringify(JSON.stringify({ model: "gpt-4o-mini-tts", input: text, voice: "alloy" }))} \
        -o ${outPath}`,
    );
  },
};

const providers = [macSay, openai];

const cacheDir = path.resolve(".demo-cache");

function cached(provider: TTSProvider): TTSProvider {
  return {
    ...provider,
    generate: (text, outPath) => {
      const key = createHash("sha256")
        .update(`${provider.name}\n${text}`)
        .digest("hex")
        .slice(0, 16);
      const ext = provider.ext;
      const cachePath = path.join(cacheDir, `${key}${ext}`);

      if (!fs.existsSync(cachePath)) {
        fs.mkdirSync(cacheDir, { recursive: true });
        provider.generate(text, cachePath);
      }

      fs.copyFileSync(cachePath, outPath);
    },
  };
}

export function getProvider(): TTSProvider {
  for (const p of providers) {
    if (p.available()) {
      console.log(`Using TTS: ${p.name}`);
      return cached(p);
    }
  }
  throw new Error(
    "No TTS provider available. Install macOS `say` or set OPENAI_API_KEY.",
  );
}
