// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { normalizeUrl, ping } from '../src/services/api';
import { rememberInstance } from '../src/services/instances';
import { useConnection } from '../src/store/connectionStore';
import { useAccounts } from '../src/store/accountStore';
import { theme, fonts } from '../src/constants/theme';

export default function Connect() {
  const router = useRouter();
  // Reached from Settings > Add another ledger. The screen is otherwise the
  // first-run flow, and adding a second ledger is not a first run.
  const adding = useLocalSearchParams<{ add?: string }>().add === '1';
  const refresh = useConnection((s) => s.refresh);
  const loadAccounts = useAccounts((s) => s.load);

  const [url, setUrl] = useState('');
  // Optional. Blank falls back to host:port, which is still better than
  // nothing once there is more than one ledger in the list.
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const canTest = url.trim().length > 0 && token.trim().length > 0;

  async function handleTest() {
    setTesting(true);
    setResult(null);
    const creds = { url: normalizeUrl(url), token: token.trim() };
    const r = await ping(creds);
    setTesting(false);

    if (r.ok) {
      setResult({
        ok: true,
        text: `Connected. ${r.data.account_count} accounts${r.data.book_locked ? ', but GnuCash desktop currently has the book open' : ''}.`,
      });
    } else {
      setResult({ ok: false, text: r.error });
    }
  }

  async function handleSave() {
    if (!canTest) return;
    // Stores the pair and makes it active, so this ledger can be switched
    // back to later without retyping the token.
    await rememberInstance(url, token, name);
    await refresh();
    await loadAccounts();
    if (adding) router.replace('/(tabs)/settings');
    else router.replace('/(tabs)/accounts');
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Connect to GnuCash</Text>
        <Text style={styles.lede}>
          This app talks straight to your own GnuCash database through PostgREST. Nothing is stored
          on a server of ours, because there isn't one.
        </Text>

        <Text style={styles.label}>Name this ledger</Text>
        <TextInput
          style={styles.input}
          placeholder="e.g. Production, or Dev clone"
          placeholderTextColor={theme.inkFaint}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          autoCorrect={false}
        />
        <Text style={styles.hint}>
          Optional. It only labels this connection in Settings, so you can switch between ledgers
          without re-entering a token. Left blank, the address is used.
        </Text>

        <Text style={styles.label}>PostgREST URL</Text>
        <TextInput
          style={styles.input}
          placeholder="http://10.8.0.1:3003"
          placeholderTextColor={theme.inkFaint}
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.hint}>
          A private address is expected here. If your server is only reachable over a VPN, this app
          will only work while that VPN is connected — which is the point.
        </Text>

        <Text style={styles.label}>JWT token</Text>
        <TextInput
          style={[styles.input, styles.inputMultiline]}
          placeholder="eyJhbGciOi..."
          placeholderTextColor={theme.inkFaint}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Text style={styles.hint}>
          Stored in the device keystore, and never sent anywhere except your own server.
        </Text>

        {result ? (
          <View style={[styles.result, { borderLeftColor: result.ok ? theme.moss : theme.coral }]}>
            <Text style={[styles.resultDot, { color: result.ok ? theme.moss : theme.coral }]}>●</Text>
            <Text style={styles.resultText}>{result.text}</Text>
          </View>
        ) : null}

        <Pressable
          style={[styles.btnGhost, !canTest && styles.btnDisabled]}
          disabled={!canTest || testing}
          onPress={handleTest}
        >
          <Text style={styles.btnGhostText}>{testing ? 'Testing…' : 'Test connection'}</Text>
        </Pressable>

        <Pressable
          style={[styles.btn, !canTest && styles.btnDisabled]}
          disabled={!canTest}
          onPress={handleSave}
        >
          <Text style={styles.btnText}>Save and continue</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 24, paddingBottom: 300 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium, marginBottom: 10 },
  lede: { color: theme.inkSoft, fontSize: 14, lineHeight: 21, marginBottom: 28 },
  label: { color: theme.ink, fontSize: 13, fontFamily: fonts.sansMedium, marginBottom: 8, marginTop: 12 },
  input: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: theme.ink,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 88, textAlignVertical: 'top' },
  hint: { color: theme.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 8 },
  result: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.surface,
    borderLeftWidth: 3,
    borderRadius: 8,
    padding: 14,
    marginTop: 24,
  },
  resultDot: { fontSize: 11, marginRight: 10, marginTop: 3 },
  resultText: { color: theme.inkSoft, fontSize: 13, lineHeight: 19, flex: 1 },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  btnText: { color: theme.bg, fontSize: 15, fontFamily: fonts.sansMedium },
  btnGhost: { borderRadius: 12, paddingVertical: 16, alignItems: 'center', marginTop: 24 },
  btnGhostText: { color: theme.accent, fontSize: 15, fontFamily: fonts.sansMedium },
  btnDisabled: { opacity: 0.4 },
});
