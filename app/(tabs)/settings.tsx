// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert,
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
import { saveAiModel, getAiModel } from '../../src/services/aiKey';
import {
  adoptLegacyKey, listAiKeys, addAiKey, renameAiKey, forgetAiKey, labelFor,
  type AiKeyProfile,
} from '../../src/services/aiKeys';
import { DEFAULT_GEMINI_MODEL, KNOWN_GEMINI_MODELS } from '../../src/services/receiptExtraction';
import { loadMemory, forgetAll } from '../../src/services/merchantMemory';
import { descriptions, memos, clearWording } from '../../src/services/wordingMemory';
import {
  listInstances, getActiveId, activate, forgetInstance, renameInstance,
  adoptCurrentCredentials, type Instance,
} from '../../src/services/instances';
import { Icon } from '../../src/components/Icon';
import { TextField } from '../../src/components/TextField';
import { SettingRow } from '../../src/components/SettingRow';
import { usePrivacy } from '../../src/store/privacyStore';
import Constants from 'expo-constants';
import { theme, fonts } from '../../src/constants/theme';
import { useEntryTabGuard } from '../../src/hooks/useEntryTabGuard';

export default function Settings() {
  useEntryTabGuard('settings');
  const router = useRouter();
  const conn = useConnection();
  const loadAccounts = useAccounts((s) => s.load);
  const resetAccounts = useAccounts((s) => s.reset);
  const accountCount = useAccounts((s) => s.accounts.length);
  const cachedAt = useAccounts((s) => s.cachedAt);

  const [url, setUrl] = useState<string | null>(null);
  const [crash, setCrash] = useState(isCrashReportingEnabled());
  // The saved key is shown masked and never re-rendered in full. What is being
  // typed lives inside the sheet, so no half-entered secret is held here.
  const [aiKeys, setAiKeys] = useState<AiKeyProfile[]>([]);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [keyNameDraft, setKeyNameDraft] = useState('');
  const [editing, setEditing] = useState<'key' | 'model' | null>(null);
  // The model is shown in full -- it is not a secret, and the whole point of
  // exposing it is to be able to read what is in force before changing it.
  const [savedModel, setSavedModel] = useState<string>(DEFAULT_GEMINI_MODEL);

  // How many merchants this phone has learned an account for. A count only --
  // the names are never shown here, because a merchant list is a spending
  // history and this screen is not where that belongs.
  const [merchants, setMerchants] = useState(0);
  const [wording, setWording] = useState(0);
  const [lineNotes, setLineNotes] = useState(0);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  // Which ledger row is being renamed, and what is being typed into it.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  // Shared with the eye on Accounts and the register -- one store, so the
  // toggle here and the icon there can never disagree.
  const hidden = usePrivacy((s) => s.hidden);
  const toggleHidden = usePrivacy((s) => s.toggle);
  const loadPrivacy = usePrivacy((s) => s.load);

  useEffect(() => {
    loadPrivacy();
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
    // Adopt first: a phone that has been scanning since before the key list
    // existed has its key under the old single entry, and without this the
    // section would read "no keys" to someone who plainly has one.
    adoptLegacyKey().then(setAiKeys);
    getAiModel().then(setSavedModel);
    loadMemory().then((m) => setMerchants(Object.keys(m).length));
    descriptions.load().then((c) => setWording(c.rows.length));
    memos.load().then((c) => setLineNotes(c.rows.length));
  }, []);

  function confirmForgetKey(k: AiKeyProfile) {
    Alert.alert(
      `Forget ${labelFor(k)}?`,
      aiKeys.length === 1
        ? 'This is your only Gemini key. Forgetting it turns receipt scanning off until you add another. Nothing else is affected.'
        : 'Removes it from this phone. Scans will rotate through the keys that are left.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: async () => { setAiKeys(await forgetAiKey(k.id)); },
        },
      ],
    );
  }

  function confirmForget(i: Instance, active: boolean) {
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
              await clearWording();
              resetAccounts();
              conn.reset();
              router.replace('/connect');
            }
          },
        },
      ],
    );
  }

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
            await clearWording();
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
        <ConnectionBanner />
        <Text style={styles.h1}>Settings</Text>

        <Text style={styles.section}>LEDGER</Text>
        <View style={styles.card}>
          <Row label="Server" value={url ?? 'Not configured'} mono />
          <Row label="Status" value={conn.state} />
          {conn.lockedBy ? <Row label="Locked by" value={conn.lockedBy} /> : null}
          <Row label="Accounts" value={accountCount ? String(accountCount) : '—'} mono />
          <Row
            label="Trading accounts"
            value={conn.state === 'online' || conn.state === 'locked'
              ? (conn.tradingAccounts ? 'On' : 'Off')
              : '—'}
          />
        </View>

        <Pressable style={styles.btnGhost} onPress={async () => { await conn.refresh(); await loadAccounts(); }}>
          <Text style={styles.btnGhostText}>Refresh accounts</Text>
        </Pressable>

        {instances.length > 0 ? (
          <>
            <Text style={styles.section}>LEDGERS ON THIS PHONE</Text>
            <View style={styles.card}>
              {instances.map((i) => {
                const active = i.id === activeId;

                // Renaming swaps the row for an editor in place, the same way
                // the Gemini key and model rows do, so the screen has one way
                // of editing rather than two.
                if (renaming === i.id) {
                  return (
                    <View key={i.id} style={styles.ledgerEditor}>
                      <Text style={styles.editorLabel}>Name for this ledger</Text>
                      <TextField
                        variant="active"
                        style={styles.editorInput}
                        value={renameDraft}
                        onChangeText={setRenameDraft}
                        placeholder={i.url}
                        autoCapitalize="words"
                        autoCorrect={false}
                      />
                      <Text style={styles.hint}>
                        A label on this phone only. It never reaches your book, and the address
                        and token are untouched. Leave it empty to go back to the address.
                      </Text>
                      <View style={styles.editorActions}>
                        <Pressable style={styles.editorGhost} onPress={() => setRenaming(null)}>
                          <Text style={styles.editorGhostText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          style={styles.editorSave}
                          onPress={async () => {
                            setInstances(await renameInstance(i.id, renameDraft));
                            setRenaming(null);
                          }}
                        >
                          <Text style={styles.editorSaveText}>Save</Text>
                        </Pressable>
                      </View>
                    </View>
                  );
                }

                return (
                  <Pressable
                    key={i.id}
                    style={({ pressed }) => [styles.ledgerRow, pressed && styles.rowPressed]}
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
                      await clearWording();
                      resetAccounts();
                      conn.reset();
                      setActiveId(i.id);
                      setUrl(ok.url);
                      await conn.refresh();
                      await loadAccounts();
                      setSwitching(false);
                    }}
                    onLongPress={() => confirmForget(i, active)}
                  >
                    <View style={styles.ledgerText}>
                      <Text style={[styles.ledgerName, active ? styles.ledgerNameOn : null]}>
                        {i.name}
                      </Text>
                      <Text style={styles.ledgerUrl} numberOfLines={1}>{i.url}</Text>
                    </View>
                    <Text style={styles.ledgerMark}>{active ? 'In use' : 'Switch'}</Text>
                    {/* The screen's own affordance for "this can be edited".
                        Rename was on long-press first, which is invisible --
                        needing a sentence of prose to explain a gesture is the
                        tell that the affordance is missing. Tapping the row
                        still switches; only the pencil renames. */}
                    <Pressable
                      style={styles.ledgerPencil}
                      onPress={() => { setRenameDraft(i.name); setRenaming(i.id); }}
                      accessibilityRole="button"
                      accessibilityLabel={`Rename ${i.name}`}
                    >
                      <Icon name="edit" size={14} color={theme.disabled} />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>
            <Pressable style={styles.btnGhost} onPress={() => router.push('/connect?add=1')}>
              <Text style={styles.btnGhostText}>Add another ledger</Text>
            </Pressable>
            <Text style={styles.hint}>
              A token is signed by one server, so each ledger keeps its own. Switching reloads the
              chart of accounts. Tap the pencil to rename one, long-press to forget it. Adding one
              does not disconnect you from this one.
            </Text>
          </>
        ) : null}

        <Text style={styles.section}>RECEIPT SCANNING</Text>
        <View style={styles.card}>
          {aiKeys.map((k) => {
            if (renamingKey === k.id) {
              return (
                <View key={k.id} style={styles.ledgerEditor}>
                  <Text style={styles.editorLabel}>Name for this key</Text>
                  <TextField
                    variant="active"
                    style={styles.editorInput}
                    value={keyNameDraft}
                    onChangeText={setKeyNameDraft}
                    placeholder={`••••••••${k.tail}`}
                    autoCapitalize="words"
                    autoCorrect={false}
                  />
                  <Text style={styles.hint}>
                    A label on this phone only. Useful for recording which Google account a key
                    came from, which is the thing that decides whether it has its own quota.
                  </Text>
                  <View style={styles.editorActions}>
                    <Pressable style={styles.editorGhost} onPress={() => setRenamingKey(null)}>
                      <Text style={styles.editorGhostText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={styles.editorSave}
                      onPress={async () => {
                        setAiKeys(await renameAiKey(k.id, keyNameDraft));
                        setRenamingKey(null);
                      }}
                    >
                      <Text style={styles.editorSaveText}>Save</Text>
                    </Pressable>
                  </View>
                </View>
              );
            }

            const flagged = k.exhaustedAt != null;
            return (
              <Pressable
                key={k.id}
                style={({ pressed }) => [styles.ledgerRow, pressed && styles.rowPressed]}
                onLongPress={() => confirmForgetKey(k)}
              >
                <View style={styles.ledgerText}>
                  <Text style={[styles.ledgerName, styles.ledgerNameOn]}>{labelFor(k)}</Text>
                  <Text style={styles.ledgerUrl} numberOfLines={1}>{`••••••••${k.tail}`}</Text>
                </View>
                {/* The flag stays up until this key next succeeds, not until a
                    timer elapses. A cooldown passing proves nothing about
                    whether the quota came back. */}
                <Text style={flagged ? styles.keyFlag : styles.keyOk}>
                  {flagged
                    ? `Limit hit ${new Date(k.exhaustedAt!).toLocaleTimeString(undefined, {
                        hour: '2-digit', minute: '2-digit' })}`
                    : 'Ready'}
                </Text>
                <Pressable
                  style={styles.ledgerPencil}
                  onPress={() => { setKeyNameDraft(k.name); setRenamingKey(k.id); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${labelFor(k)}`}
                >
                  <Icon name="edit" size={14} color={theme.disabled} />
                </Pressable>
              </Pressable>
            );
          })}
          <SettingRow
            label={aiKeys.length === 0 ? 'Gemini key' : 'Add another key'}
            value={aiKeys.length === 0 ? 'Not set' : `${aiKeys.length} saved`}
            mono
            secure
            open={editing === 'key'}
            onOpen={() => setEditing('key')}
            onCancel={() => setEditing(null)}
            placeholder="Paste your Gemini API key"
            help="Your own key, billed to your own Google account. It stays in this phone's keystore and is sent only to Google — never to your ledger, and never to us."
            onSave={async (key) => {
              setAiKeys(await addAiKey(key));
              setEditing(null);
            }}
          />
          <SettingRow
            label="Model"
            value={savedModel}
            mono
            open={editing === 'model'}
            onOpen={() => setEditing('model')}
            onCancel={() => setEditing(null)}
            placeholder="Another model name"
            current={savedModel}
            suggestions={KNOWN_GEMINI_MODELS}
            help="Worth changing if Google retires one, or if a scan keeps saying the scanner is busy — that is usually a passing spike, and another model often goes through in the meantime."
            onSave={async (model) => {
              // The default is stored as NO OVERRIDE rather than as its own
              // name, so a release that changes the default carries anyone who
              // picked it along instead of pinning them to today's.
              await saveAiModel(model === DEFAULT_GEMINI_MODEL ? '' : model);
              setSavedModel(await getAiModel());
              setEditing(null);
            }}
          />
          {aiKeys.length === 0 ? (
            <Text style={styles.hintInset}>Scanning is off until you add a key.</Text>
          ) : aiKeys.length === 1 ? (
            <Text style={styles.hintInset}>
              Long-press a key to forget it. Add a second and scans will alternate between them,
              moving on by itself when one hits its limit.
            </Text>
          ) : (
            <Text style={styles.hintInset}>
              Scans rotate through these {aiKeys.length} keys, and move on by themselves when one
              hits its limit. A flag clears when that key next works. If they all run out together
              they are probably one Google project sharing one quota — separate projects, or
              separate Google accounts, are what actually multiply it.
            </Text>
          )}
        </View>

        <Text style={styles.section}>PRIVACY</Text>
        <View style={styles.card}>
          <ToggleRow
            label="Hide balances"
            sub="Masks amounts on the Accounts screen and in registers"
            value={hidden}
            onChange={() => { void toggleHidden(); }}
          />
          <ToggleRow
            label="Crash reporting"
            sub="Off by default. Sends crash traces only, never your ledger data."
            value={crash}
            onChange={async (v) => { setCrash(v); await setCrashReportingEnabled(v); }}
          />
          <Text style={styles.hintInset}>
            {merchants > 0
              ? `Remembered which account you chose at ${merchants} merchant${merchants === 1 ? '' : 's'}. Kept on this phone, never written to your book and never sent anywhere. It is only recalled when a later scan reads the shop name the same way, and often it does not.`
              : 'Nothing remembered yet. Choosing an account for a scanned line records what you meant, though a scan only recalls it when the shop name comes back the same, and often it does not.'}
          </Text>
          {merchants > 0 ? (
            <Pressable
              style={styles.btnGhostInset}
              onPress={async () => {
                await forgetAll();
                setMerchants(0);
                Alert.alert('Forgotten', 'Scans will propose accounts from the receipt text alone again.');
              }}
            >
              <Text style={styles.btnGhostText}>Forget merchants</Text>
            </Pressable>
          ) : null}
          {/* The chart of accounts used to be the only copy of your book this
              phone held. The description list is the second, so it is said
              here rather than left to be found out. */}
          <Text style={styles.hintInset}>
            {wording + lineNotes > 0
              ? `Holding ${wording.toLocaleString()} description${wording === 1 ? '' : 's'} and ${lineNotes.toLocaleString()} line note${lineNotes === 1 ? '' : 's'} copied from your book, so the Entry screen can finish wording you have used before. Taken from every account, not just the one you are entering against. Words and a count only, no amounts and no accounts. Both are dropped whenever you switch or disconnect a ledger.`
              : 'The wording your book already uses will be copied here the first time the Entry screen reaches the ledger, so it can finish a description or a line note you have typed before. Words and a count only, no amounts and no accounts.'}
          </Text>
          {wording + lineNotes > 0 ? (
            <Pressable
              style={styles.btnGhostInset}
              onPress={async () => {
                await clearWording();
                setWording(0);
                setLineNotes(0);
                Alert.alert(
                  'Forgotten',
                  'Descriptions and line notes are typed from scratch until the Entry screen fetches them again.',
                );
              }}
            >
              <Text style={styles.btnGhostText}>Forget wording</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.section}>WHAT THIS APP WILL NOT DO</Text>
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

        <Text style={styles.footer}>
          mini-gnucash {Constants.expoConfig?.version ?? ''}
          {cachedAt ? ` · account list saved ${new Date(cachedAt).toLocaleString()}` : ''}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// A row of fact. Not tappable -- anything editable on this screen is a
// SettingRow, which draws the pencil that says so.
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// The handoff's toggle, at its stated size: a 40x24 track, an 18px knob, ink
// when on and #C8C0B0 when off. Built rather than themed because RN's Switch
// renders at the platform's own dimensions on each OS, and this one has to
// match the rest of a hand-drawn screen.
function ToggleRow({
  label, sub, value, onChange,
}: { label: string; sub: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      style={styles.switchRow}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
    >
      <View style={styles.switchText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.hint}>{sub}</Text>
      </View>
      <View style={[styles.track, value && styles.trackOn]}>
        <View style={[styles.knob, value && styles.knobOn]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { paddingBottom: 60 },
  h1: {
    color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6,
  },
  section: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.1, fontFamily: fonts.sansMedium,
    paddingHorizontal: 20, paddingTop: 22, paddingBottom: 6,
  },
  card: {
    backgroundColor: theme.surface,
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: theme.hairlineStrong,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowPressed: { backgroundColor: theme.pressed },
  rowLabel: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  rowValue: {
    color: theme.inkSoft, fontSize: 14, fontFamily: fonts.sans,
    maxWidth: '55%', textAlign: 'right',
  },
  rowValueMono: { fontFamily: fonts.mono, fontSize: 13 },
  ledgerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  ledgerText: { flex: 1, marginRight: 12 },
  ledgerName: { color: theme.inkSoft, fontSize: 14, fontFamily: fonts.sansMedium },
  ledgerNameOn: { color: theme.ink },
  ledgerUrl: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.mono },
  ledgerMark: { color: theme.ink, fontSize: 12, fontFamily: fonts.sansSemi },
  ledgerPencil: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  // Coral is this app's "look at this", used for the same job on the Accounts
  // tab. A tired key is not an error, so it is not styled as one.
  keyFlag: { color: theme.coral, fontSize: 12, fontFamily: fonts.sansSemi },
  keyOk: { color: theme.inkFaint, fontSize: 12, fontFamily: fonts.sans },
  ledgerEditor: {
    backgroundColor: theme.surface,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  editorLabel: { color: theme.inkFaint, fontSize: 12, fontFamily: fonts.sans },
  // Spacing only. The field itself is TextField's 'active' variant.
  editorInput: { marginTop: 8 },
  editorActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 },
  editorGhost: {
    borderWidth: 1, borderColor: theme.hairlineStrong, borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12, marginRight: 8,
  },
  editorGhostText: { color: theme.inkSoft, fontSize: 13, fontFamily: fonts.sans },
  editorSave: {
    backgroundColor: theme.ink, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14,
  },
  editorSaveText: { color: theme.bg, fontSize: 13, fontFamily: fonts.sansMedium },
  switchRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  switchText: { flex: 1, marginRight: 12 },
  track: {
    width: 40, height: 24, borderRadius: 12, backgroundColor: theme.toggleOff,
    justifyContent: 'center', paddingHorizontal: 3,
  },
  trackOn: { backgroundColor: theme.ink },
  knob: { width: 18, height: 18, borderRadius: 9, backgroundColor: theme.bg },
  knobOn: { alignSelf: 'flex-end' },
  hint: { color: theme.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 3, fontFamily: fonts.sans },
  hintInset: {
    color: theme.inkFaint, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 20, paddingVertical: 12, fontFamily: fonts.sans,
  },
  prose: {
    color: theme.inkSoft, fontSize: 13, lineHeight: 20,
    paddingHorizontal: 20, paddingVertical: 14, fontFamily: fonts.sans,
  },
  btnGhost: { paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  btnGhostInset: { paddingVertical: 14, paddingHorizontal: 20 },
  btnGhostText: { color: theme.ink, fontSize: 14, fontFamily: fonts.sansMedium },
  btnDanger: {
    borderWidth: 1, borderColor: theme.coral, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', marginTop: 28, marginHorizontal: 20,
  },
  btnDangerText: { color: theme.coral, fontSize: 15, fontFamily: fonts.sansMedium },
  footer: {
    color: theme.inkFaint, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 20, paddingTop: 20, fontFamily: fonts.sans,
  },
});
