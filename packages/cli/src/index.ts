#!/usr/bin/env node
// Copyright 2026 The Integration Verifier Authors
// SPDX-License-Identifier: Apache-2.0

import { run } from "./program.js";

process.exitCode = await run(process.argv.slice(2));
