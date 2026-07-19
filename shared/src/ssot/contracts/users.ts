export type CreatedUserResult = {
  id: number | string;
  username?: string;
  role: string;
};

export type EnabledLoginResult = { id: number | string; username: string };
export type AdminUserResult = { id: number | string; username: string; role: string };
