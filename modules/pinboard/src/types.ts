export type ColumnColor = 'slate' | 'blue' | 'amber' | 'emerald' | 'rose' | 'violet';
export type CardPriority = 'low' | 'medium' | 'high';

export interface Column {
  id: string;
  title: string;
  color: ColumnColor;
}

export interface Card {
  id: string;
  title: string;
  description: string;
  columnId: string;
  position: number;
  priority: CardPriority;
  assignee: string;
  /** Empty when no deadline is set; otherwise a calendar date in YYYY-MM-DD. */
  dueDate: string;
  labels: string[];
}

export interface Board {
  id: string;
  invite_code: string;
  title: string;
  description: string;
  columns: Column[];
  cards: Card[];
  revision: number;
  created_at: string;
  updated_at: string;
}

export type CardPatch = Partial<Omit<Card, 'id'>>;

/** Operations touch only their own fields; the server serializes edits to a board. */
export type Operation =
  | { type: 'update_board'; patch: Partial<Pick<Board, 'title' | 'description'>> }
  | { type: 'add_column'; column: Column }
  | { type: 'update_column'; id: string; patch: Partial<Pick<Column, 'title' | 'color'>> }
  | { type: 'reorder_columns'; columnIds: string[] }
  | { type: 'delete_column'; id: string; targetColumnId: string }
  | { type: 'create_card'; card: Card }
  | { type: 'update_card'; id: string; patch: CardPatch }
  | { type: 'move_card'; id: string; columnId: string; position: number }
  | { type: 'delete_card'; id: string };
