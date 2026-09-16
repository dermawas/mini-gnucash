// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// A settings row that swaps into an editor in place, per the 2026-09-08
// handoff: label left, value right, a pencil to say it is editable, and on tap
// the row becomes a labelled input with Cancel and Save. Other rows do not
// move.
//
// It replaced a pair of bottom sheets built the day before, and the handoff's
// reasoning for expanding in place is the better one for this screen: the row
// stays where it was, so what is being edited never loses its context, and an
// explicit Save keeps a mistake cheap. A sheet is worth its cost when there
// are rules to explain; here the explanation is one line of help text, which
// fits under the input.
//
// `suggestions` is what makes this work for the Gemini model. A model name is
// not something anyone recalls exactly, and a typo does not fail here -- it
// fails at the next scan, as a 404, with a receipt in your hand. Offering the
// names that have actually been run, while leaving the field free, is the only
// shape that is both convenient and honest about a list that Google changes.

import { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Icon } from './Icon';
import { theme, fonts } from '../constants/theme';
import { TextField } from './TextField';

export type Suggestion = { id: string; note: string };

type Props = {
  label: string;
  /** What the row reads when closed. */
  value: string;
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSave: (next: string) => void;
  /** Amounts, keys and identifiers read better in mono. */
  mono?: boolean;
  secure?: boolean;
  placeholder?: string;
  /** One line under the input, for a rule the value has to satisfy. */
  help?: string;
  /** Tappable known-good values, offered above the free-text field. */
  suggestions?: Suggestion[];
  /** Currently in force, so a suggestion can be ticked. */
  current?: string;
  /** Shown as a third, destructive action when present. */
  onRemove?: () => void;
  removeLabel?: string;
};

export function SettingRow({
  label, value, open, onOpen, onCancel, onSave,
  mono, secure, placeholder, help, suggestions, current, onRemove, removeLabel,
}: Props) {
  const [draft, setDraft] = useState('');

  // The draft is scratch, and for the API key it is a secret in flight. It
  // does not outlive one opening of the editor, so reopening never shows what
  // was half-typed the time before.
  useEffect(() => { if (!open) setDraft(''); }, [open]);

  if (!open) {
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}. Tap to edit.`}
      >
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, mono && styles.valueMono]} numberOfLines={1}>{value}</Text>
        <Icon name="edit" size={14} color={theme.disabled} />
      </Pressable>
    );
  }

  return (
    <View style={styles.editor}>
      <Text style={styles.editorLabel}>{label}</Text>

      {suggestions?.length ? (
        <View style={styles.suggestions}>
          {suggestions.map((s) => {
            const on = s.id === current;
            return (
              <Pressable
                key={s.id}
                style={[styles.suggestion, on && styles.suggestionOn]}
                onPress={() => onSave(s.id)}
              >
                <View style={styles.suggestionMain}>
                  <Text style={styles.suggestionId}>{s.id}</Text>
                  <Text style={styles.suggestionNote}>{s.note}</Text>
                </View>
                {on ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <TextField
        variant="active"
        mono={mono}
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
      />

      {help ? <Text style={styles.help}>{help}</Text> : null}

      <View style={styles.actions}>
        {onRemove ? (
          <Pressable style={styles.remove} onPress={onRemove}>
            <Text style={styles.removeText}>{removeLabel ?? 'Remove'}</Text>
          </Pressable>
        ) : null}
        <View style={styles.spacer} />
        <Pressable style={styles.ghost} onPress={onCancel}>
          <Text style={styles.ghostText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.save, !draft.trim() && styles.saveOff]}
          disabled={!draft.trim()}
          onPress={() => onSave(draft.trim())}
        >
          <Text style={styles.saveText}>Save</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 14, paddingHorizontal: 20,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowPressed: { backgroundColor: theme.pressed },
  label: { flex: 1, color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  value: {
    color: theme.inkSoft, fontSize: 14, fontFamily: fonts.sans,
    marginRight: 8, maxWidth: '55%', textAlign: 'right',
  },
  valueMono: { fontFamily: fonts.mono },
  editor: {
    backgroundColor: theme.surface,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  editorLabel: { color: theme.inkFaint, fontSize: 12, fontFamily: fonts.sans },
  suggestions: { marginTop: 10 },
  suggestion: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.bg, borderRadius: 8,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 10, paddingHorizontal: 12, marginBottom: 6,
  },
  suggestionOn: { borderColor: theme.ink, borderWidth: 1.5 },
  suggestionMain: { flex: 1, marginRight: 8 },
  suggestionId: { color: theme.ink, fontSize: 13, fontFamily: fonts.mono },
  suggestionNote: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 15, marginTop: 3, fontFamily: fonts.sans,
  },
  check: { color: theme.ink, fontSize: 14, fontFamily: fonts.sansSemi },
  // Spacing only. The field itself is TextField's 'active' variant.
  input: { marginTop: 8 },
  help: { color: theme.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 8, fontFamily: fonts.sans },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  spacer: { flex: 1 },
  remove: { paddingVertical: 8, paddingHorizontal: 4 },
  removeText: { color: theme.coral, fontSize: 13, fontFamily: fonts.sansMedium },
  ghost: {
    borderWidth: 1, borderColor: theme.hairlineStrong, borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12, marginRight: 8,
  },
  ghostText: { color: theme.inkSoft, fontSize: 13, fontFamily: fonts.sans },
  save: { backgroundColor: theme.ink, borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14 },
  saveOff: { opacity: 0.35 },
  saveText: { color: theme.bg, fontSize: 13, fontFamily: fonts.sansMedium },
});
