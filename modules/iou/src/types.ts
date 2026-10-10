export interface Member {
  id: string;
  name: string;
}

export interface Expense {
  id: string;
  type: 'expense';
  description: string;
  /** Integer minor currency units, such as cents for USD. */
  amount: number;
  paidBy: string;
  /** Each participant's share, in integer minor currency units. */
  shares: Record<string, number>;
  category: string;
  date: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  type: 'payment';
  fromId: string;
  toId: string;
  amount: number;
  note: string;
  date: string;
  createdAt: string;
}

export type Transaction = Expense | Payment;

export interface Group {
  id: string;
  name: string;
  description: string;
  currency: string;
  icon: string;
  color: string;
  inviteCode: string;
  createdAt: string;
  updatedAt: string;
  members: Member[];
  transactions: Transaction[];
}

export interface MemberBalance {
  member: Member;
  paid: number;
  share: number;
  /** Positive means this member is owed money; negative means they owe. */
  balance: number;
}

export interface Settlement {
  fromId: string;
  toId: string;
  amount: number;
}
