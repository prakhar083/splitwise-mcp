/**
 * The subset of the Splitwise v3.0 API shapes this server reads.
 * https://dev.splitwise.com/
 *
 * Splitwise returns monetary values as decimal strings ("12.50"); they are
 * converted to integer minor units before any arithmetic.
 */

export interface Balance {
  currency_code: string;
  amount: string;
}

export interface User {
  id: number;
  first_name: string;
  last_name: string | null;
  email?: string | null;
  default_currency?: string;
}

export interface GroupMember extends User {
  balance?: Balance[];
}

export interface Debt {
  from: number;
  to: number;
  amount: string;
  currency_code: string;
}

export interface Group {
  id: number;
  name: string;
  group_type?: string | null;
  updated_at?: string;
  simplify_by_default?: boolean;
  members: GroupMember[];
  original_debts?: Debt[];
  simplified_debts?: Debt[];
}

export interface Friend extends User {
  balance: Balance[];
  groups?: { group_id: number; balance: Balance[] }[];
  updated_at?: string;
}

export interface ExpenseShare {
  user: User | null;
  user_id: number;
  paid_share: string;
  owed_share: string;
  net_balance?: string;
}

export interface Expense {
  id: number;
  group_id: number | null;
  description: string;
  details: string | null;
  payment: boolean;
  cost: string;
  currency_code: string;
  date: string;
  created_at?: string;
  updated_at?: string;
  deleted_at: string | null;
  created_by?: User | null;
  category?: { id: number; name: string } | null;
  users: ExpenseShare[];
  repayments?: Debt[];
}

export interface ExpenseQuery {
  group_id?: number;
  friend_id?: number;
  dated_after?: string;
  dated_before?: string;
  updated_after?: string;
  limit?: number;
  offset?: number;
}

/**
 * Body for create_expense / update_expense. Splitwise expects per-user shares as
 * flattened keys: users__0__user_id, users__0__paid_share, users__0__owed_share.
 */
export type ExpensePayload = Record<string, string | number | boolean>;
