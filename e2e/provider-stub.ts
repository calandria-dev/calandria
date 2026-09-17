import { createServer, type Server } from "node:http";

export const INITIAL_OLLAMA_MODELS = ["llama3.2:3b", "qwen2.5:7b", "mistral:7b"];
export const REFRESHED_OLLAMA_MODELS = [...INITIAL_OLLAMA_MODELS, "gemma3:4b"];

export class OllamaStub {
  private server: Server | null = null;
  private currentModels: string[];
  private port = 0;

  constructor(models = INITIAL_OLLAMA_MODELS) {
    this.currentModels = [...models];
  }

  async start(port = 0): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/tags") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: this.currentModels.map((name) => ({ name, model: name, details: { family: name.split(/[.:]/)[0] } })) }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        this.server!.off("error", reject);
        this.port = (this.server!.address() as import("node:net").AddressInfo).port;
        resolve();
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setModels(models: string[]): void {
    this.currentModels = [...models];
  }

  async restart(models: string[]): Promise<void> {
    await this.close();
    this.setModels(models);
    await this.start(this.port);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
