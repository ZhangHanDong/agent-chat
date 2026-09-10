#!/usr/bin/env node

import os from 'node:os';

import { prepareBridgeContainerOwnership } from '../src/bridge-container-owner.mjs';

const runtimeRoot = process.env.HAGENCY_RUNTIME_DIR || '/var/lib/hagency';
prepareBridgeContainerOwnership({ runtimeRoot, hostname: os.hostname() });
