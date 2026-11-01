#!/usr/bin/env node
import { serveMcp } from "./serve.js";

await serveMcp(process.argv.slice(2));
