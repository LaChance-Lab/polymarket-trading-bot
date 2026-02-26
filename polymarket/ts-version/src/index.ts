import "dotenv/config";
import { PolymarketBot } from "./bot";

async function main(): Promise<void> {
  const bot = new PolymarketBot();

  process.on("SIGINT", () => {
    console.log("\nShutting down bot gracefully...");
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("\nBot terminated");
    process.exit(0);
  });

  try {
    await bot.start();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Bot failed to start:", msg);
    process.exit(1);
  }
}

main();
