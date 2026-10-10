import type { Board, Card, Column, ColumnColor } from './types';
export type ModalState =
  | { type: 'create' }
  | { type: 'join'; code?: string }
  | { type: 'share'; board: Board }
  | { type: 'board'; board: Board }
  | { type: 'card'; board: Board; card: Card; isNew: boolean }
  | { type: 'column'; board: Board; column: Column; isNew: boolean }
  | { type: 'help' };
export const colors: ColumnColor[] = [
  'slate',
  'blue',
  'amber',
  'emerald',
  'rose',
  'violet',
];
export const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Something went wrong. Please try again.';
export const routeCode = () =>
  /^#\/?board\/([a-f0-9]{32})$/i
    .exec(window.location.hash)?.[1]
    .toLowerCase() ?? '';
export const routeInvitation = () =>
  /^#\/?join\/([a-f0-9]{32})$/i.exec(window.location.hash)?.[1].toLowerCase() ??
  '';
