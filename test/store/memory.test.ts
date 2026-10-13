import { MemoryStore } from "../../src/store/memory.js";
import { runStoreContract } from "./contract.js";

runStoreContract("memory", async () => new MemoryStore());
