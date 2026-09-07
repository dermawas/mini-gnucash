// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import { useEffect, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, Switch, TextInput, StyleSheet, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useConnection } from '../../src/store/connectionStore';
import { useAccounts } from '../../src/store/accountStore';
import { clearCredentials, clearAccountCache, loadCredentials } from '../../src/services/api';
import {
  isCrashReportingEnabled, setCrashReportingEnabled, loadCrashReportingPreference,
} from '../../src/services/crashReporting';
import { getAiKey, saveAiKey, saveAiModel, getAiModel, clearAiKey, maskKey } from '../../src/services/aiKey';
import { DEFAULT_GEMINI_MODEL } from '../../src/services/receiptExtraction';
import { loadMemory, forgetAll } from '../../src/services/merchantMemory';
import {
  listInstances, getActiveId, activate, forgetInstance, adoptCurrentCredentials,
  type Instance,
} from '../../src/services/instances';
import { theme } from '../../src/constants/theme';

export default function Settings() {
  const router = useRouter();
  const conn = useConnection();
  const loadAccounts = useAccounts((s) => s.load);
  const resetAccounts = useAccounts((s) => s.reset);
  const accountCount = useAccounts((s) => s.accounts.length);
  const cachedAt = useAccounts((s) => s.cachedAt);

  const [url, setUrl] = useState<string | null>(null);
  const [crash, setCrash] = useState(isCrashReportingEnabled());
  // The saved key is shown masked and never re-rendered in full. `keyDraft` is
  // only ever what the user is typing right now.
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  // The model is shown in full -- it is not a secret, and the whole point of
  // exposing it is to be able to read what is in force before changing it.
  const [savedModel, setSavedModel] = useState<string>(DEFAULT_GEMINI_MODEL);
  const [modelDraft, setModelDraft] = useState('');
  // How many merchants this phone has learned an account for. A count only --
  // the names are never shown here, because a merchant list is a spending
  // history and this screen is not where that belongs.
  const [merchants, setMerchants] = useState(0);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    loadCredentials().then((c) => setUrl(c?.url ?? null));
    // Adopts a connection made before this list existed, so the switcher is
    // not empty on an install that predates it.
    //
    // Sequenced, not parallel: adopting WRITES the active id, so reading it
    // concurrently raced and usually lost -- the active ledger then rendered
    // as "Switch" rather than "In use", which reads as though the app is
    // connected to something it is not.
    adoptCurrentCredentials().then(async (list) => {
      setInstances(list);
      setActiveId(await getActiveId());
    });
    loadCrashReportingPreference().then(() => setCrash(isCrashReportingEnabled()));
    getAiKey().then(setSavedKey);
    getAiModel().then(setSavedModel);
    loadMemory().then((m) => setMerchants(Object.keys(m).length));
  }, []);

  async function handleDisconnect() {
    Alert.alert(
      'Disconnect from this ledger?',
      'Your GnuCash book is untouched. This only removes the server address and token from this phone, and clears the saved account list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            await clearCredentials();
            await clearAccountCache();
            resetAccounts();
            conn.reset();
            router.replace('/connect');
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Settings</Text>
        <ConnectionBanner />

        <Text style={styles.section}>Ledger</Text>
        <View style={styles.card}>
          <Row label="Server" value={url ?? 'Not configured'} />
          <Row label="Status" value={conn.state} />
          {conn.lockedBy ? <Row label="Locked by" value={conn.lockedBy} /> : null}
          <Row label="Accounts" value={accountCount ? String(accountCount) : '—'} />
          <Row
            label="Trading accounts"
            value={conn.state === 'online' || conn.state === 'locked'
              ? (conn.tradingAccounts ? 'On' : 'Off')
              : '—'}
          />
          {cachedAt ? (
            <Row label="Account list saved" value={new Date(cachedAt).toLocaleString()} />
          ) : null}
        </View>

        <Pressable style={styles.btnGhost} onPress={async () => { await conn.refresh(); await loadAccounts(); }}>
          <Text style={styles.btnGhostText}>Refresh accounts</Text>
        </Pressable>

        {instances.length > 0 ? (
          <>
            <Text style={styles.section}>Ledgers on this phone</Text>
            <View style={styles.card}>
              {instances.map((i) => {
                const active = i.id === activeId;
                return (
                  <Pressable
                    key={i.id}
                    style={styles.ledgerRow}
                    disabled={active || switching}
                    onPress={async () => {
                      setSwitching(true);
                      const ok = await activate(i.id);
                      if (!ok) {
                        setSwitching(false);
                        Alert.alert(
                          'That token is gone',
                          `The saved credential for ${i.name} is no longer on this phone. Connect to it again to store a new one.`,
                        );
                        return;
                      }
                      // The chart of accounts belongs to the ledger that was
                      // open, not to this one. Keeping it would show the wrong
                      // book's accounts against the new connection.
                      await clearAccountCache();
                      resetAccounts();
                      conn.reset();
                      setActiveId(i.id);
                      setUrl(ok.url);
                      await conn.refresh();
                      await loadAccounts();
                      setSwitching(false);
                    }}
                    onLongPress={() => {
                      Alert.alert(
                        `Forget ${i.name}?`,
                        active
                          ? 'This is the ledger you are connected to. Forgetting it disconnects the app; your GnuCash book is untouched.'
                          : 'Removes its address and token from this phone. Your GnuCash book is untouched.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Forget',
                            style: 'destructive',
                            onPress: async () => {
                              await forgetInstance(i.id);
                              setInstances(await listInstances());
                              setActiveId(await getActiveId());
                              if (active) {
                                await clearAccountCache();
                                resetAccounts();
                                conn.reset();
                                router.replace('/connect');
                              }
                            },
                          },
                        ],
                      );
                    }}
                  >
                    <View style={styles.ledgerText}>
                      <Text style={[styles.ledgerName, active ? styles.ledgerNameOn : null]}>
                        {i.name}
                      </Text>
                      <Text style={styles.ledgerUrl}>{i.url}</Text>
                    </View>
                    <Text style={styles.ledgerMark}>{active ? 'In use' : 'Switch'}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              style={styles.btnGhost}
              onPress={() => router.push('/connect?add=1')}
            >
              <Text style={styles.btnGhostText}>Add another ledger</Text>
            </Pressable>
            <Text style={styles.hint}>
              A token is signed by one server, so each ledger keeps its own. Switching reloads the
              chart of accounts. Long-press to forget one. Adding one does not disconnect you from
              this one.
            </Text>
          </>
        ) : null}

        <Text style={styles.section}>Receipt scanning</Text>
        <View style={styles.card}>
          {savedKey ? (
            <Row label="Gemini key" value={maskKey(savedKey)} />
          ) : (
            <Text style={styles.hint}>
              No key saved. Scanning is off until you add one.
            </Text>
          )}
          <Row label="Model" value={savedModel} />
          <Text style={styles.prose}>
            Scanning uses a Gemini key you obtain yourself, billed to your own Google account. It is
            kept in this phone's keystore and sent only to Google, never to your ledger and never to
            us. A receipt photo is the one thing this app sends outside your own network.
          </Text>
          <TextInput
            style={styles.input}
            value={keyDraft}
            onChangeText={setKeyDraft}
            placeholder={savedKey ? 'Replace the saved key' : 'Paste your Gemini API key'}
            placeholderTextColor={theme.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <Pressable
            style={[styles.btnGhost, !keyDraft.trim() && styles.btnOff]}
            disabled={!keyDraft.trim()}
            onPress={async () => {
              await saveAiKey(keyDraft);
              setSavedKey(keyDraft.trim());
              setKeyDraft('');
              Alert.alert('Key saved', 'Receipt scanning is ready.');
            }}
          >
            <Text style={styles.btnGhostText}>Save key</Text>
          </Pressable>
          <Text style={styles.prose}>
            The model only needs changing if Google retires this one, or if it is busy for long
            enough to be annoying -- a scan that keeps saying the scanner is busy will often go
            through on a different model. Leave the box empty and save to go back to{' '}
            {DEFAULT_GEMINI_MODEL}.
          </Text>
          <TextInput
            style={styles.input}
            value={modelDraft}
            onChangeText={setModelDraft}
            placeholder={savedModel}
            placeholderTextColor={theme.inkFaint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={styles.btnGhost}
            onPress={async () => {
              await saveAiModel(modelDraft);
              const now = await getAiModel();
              setSavedModel(now);
              setModelDraft('');
              Alert.alert('Model saved', `Scans will use ${now}.`);
            }}
          >
            <Text style={styles.btnGhostText}>Save model</Text>
          </Pressable>
          {savedKey ? (
            <Pressable
              style={styles.btnGhost}
              onPress={async () => {
                await clearAiKey();
                setSavedKey(null);
                setSavedModel(DEFAULT_GEMINI_MODEL);
                Alert.alert('Key removed', 'Receipt scanning is off until you add one again.');
              }}
            >
              <Text style={styles.btnGhostText}>Remove key</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.section}>Privacy</Text>
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowLabel}>Crash reporting</Text>
              <Text style={styles.hint}>
                Off by default. Sends crash traces only, never your ledger data.
              </Text>
            </View>
            <Switch
              value={crash}
              onValueChange={async (v) => { setCrash(v); await setCrashReportingEnabled(v); }}
              trackColor={{ true: theme.accent, false: theme.hairline }}
            />
          </View>

          <Text style={styles.hint}>
            {merchants > 0
              ? `Remembered which account you chose at ${merchants} merchant${merchants === 1 ? '' : 's'}. Kept on this phone, never written to your book and never sent anywhere. It is only recalled when a later scan reads the shop name the same way, and often it does not.`
              : 'Nothing remembered yet. Choosing an account for a scanned line records what you meant, though a scan only recalls it when the shop name comes back the same, and often it does not.'}
          </Text>
          {merchants > 0 ? (
            <Pressable
              style={styles.btnGhost}
              onPress={async () => {
                await forgetAll();
                setMerchants(0);
                Alert.alert('Forgotten', 'Scans will propose accounts from the receipt text alone again.');
              }}
            >
              <Text style={styles.btnGhostText}>Forget merchants</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.section}>What this app will not do</Text>
        <View style={styles.card}>
          <Text style={styles.prose}>
            It cannot edit or delete a transaction, and it cannot reconcile. Those belong in GnuCash
            desktop, where there is an undo and the whole book in front of you.
            {'\n\n'}
            It marks entries cleared, never reconciled.
            {'\n\n'}
            It never converts between currencies for display, so there is no combined total anywhere.
          </Text>
        </View>

        <Pressable style={styles.btnDanger} onPress={handleDisconnect}>
          <Text style={styles.btnDangerText}>Disconnect</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  h1: { color: theme.ink, fontSize: 26, fontFamily: 'DMSerifDisplay', marginBottom: 16 },
  section: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.2,
    textTransform: 'uppercase', marginTop: 28, marginBottom: 8,
  },
  card: { backgroundColor: theme.surface, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 4 },
  ledgerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
  },
  ledgerText: { flex: 1, marginRight: 12 },
  ledgerName: { color: theme.inkSoft, fontSize: 14, fontWeight: '600' },
  ledgerNameOn: { color: theme.ink },
  ledgerUrl: { color: theme.inkFaint, fontSize: 11, marginTop: 2 },
  ledgerMark: { color: theme.accent, fontSize: 12, fontWeight: '600' },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.hairline,
  },
  rowLabel: { color: theme.inkSoft, fontSize: 14 },
  rowValue: { color: theme.ink, fontSize: 13, maxWidth: '60%', textAlign: 'right' },
  switchRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  switchText: { flex: 1, marginRight: 12 },
  hint: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 4 },
  prose: { color: theme.inkSoft, fontSize: 13, lineHeight: 20, paddingVertical: 14 },
  btnGhost: { paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  btnGhostText: { color: theme.accent, fontSize: 14, fontWeight: '600' },
  btnOff: { opacity: 0.4 },
  input: {
    backgroundColor: theme.bg, borderRadius: 8, color: theme.ink, fontSize: 14,
    paddingVertical: 12, paddingHorizontal: 12, marginTop: 12, minHeight: 46,
  },
  btnDanger: {
    borderWidth: 1, borderColor: theme.coral, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', marginTop: 32,
  },
  btnDangerText: { color: theme.coral, fontSize: 15, fontWeight: '600' },
});
