// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

import { Redirect } from 'expo-router';
import { useConnection } from '../src/store/connectionStore';

export default function Index() {
  const state = useConnection((s) => s.state);

  // Only 'unconfigured' routes to setup. Being offline is NOT a reason to send
  // someone back through connection setup -- their credentials are fine, they
  // are just off the VPN, and re-entering a working token would be busywork.
  if (state === 'unconfigured') return <Redirect href="/connect" />;
  return <Redirect href="/(tabs)/accounts" />;
}
