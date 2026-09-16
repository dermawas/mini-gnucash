// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';

export function generateTransactionId(): string {
  return uuidv4();
}

export function generateId(): string {
  return uuidv4();
}