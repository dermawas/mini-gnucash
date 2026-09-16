// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// Whether the Entry screen has something unsaved on it, visible to the OTHER
// tabs.
//
// Switching Out/In/Move already asks before clearing a half-built entry (see
// `chooseDirection` in entry.tsx). Tapping Accounts or Settings did not: tab
// screens stay mounted, so the entry was never lost -- it just went quiet,
// with nothing outside Entry able to tell it had something worth asking
// about. This is that one bit of state, shared so the other two tabs can ask
// the same question before they take you away from it.

import { create } from 'zustand';

type EntryDraftState = {
  dirty: boolean;
  setDirty: (dirty: boolean) => void;
  /** Bumped once the user confirms discarding a half-built entry from
   *  outside the Entry screen, so Entry can clear itself in response. */
  clearRequest: number;
  requestClear: () => void;
};

export const useEntryDraft = create<EntryDraftState>((set) => ({
  dirty: false,
  setDirty: (dirty) => set({ dirty }),
  clearRequest: 0,
  requestClear: () => set((s) => ({ clearRequest: s.clearRequest + 1 })),
}));
