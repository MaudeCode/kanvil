import { UserRoundX, UserRoundCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { auth, useIdentity } from "../data.tsx";
import {
  Button,
  Confirm,
  ErrorNotice,
  Input,
  Loading,
  EmptyState,
  Modal,
  Select,
  SelectItem,
} from "../ui.tsx";
import { formText } from "../forms.ts";
import { UserAvatar } from "./user-avatar.tsx";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
function AccountAdministration({
  onCreated,
  onCancel,
  pending,
  setPending,
}: {
  onCreated: (email: string) => void;
  onCancel: () => void;
  pending: boolean;
  setPending: (pending: boolean) => void;
}) {
  const cache = useQueryClient();
  const [error, setError] = useState<unknown>();
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setPending(true);
    setError(undefined);
    try {
      const result = await auth.admin.createUser({
        name: formText(values, "name"),
        email: formText(values, "email"),
        password: formText(values, "password"),
        role: values.get("role") === "admin" ? "admin" : "user",
      });
      if (result.error) throw new Error(result.error.message);
      await cache.invalidateQueries({ queryKey: ["kanvil", "users"] });
      onCreated(result.data.user.email);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label="Name" name="name" required maxLength={120} autoFocus />
        <Input label="Email" name="email" type="email" required autoComplete="off" />
        <Input
          label="Initial password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <Select label="Instance role" name="role">
          <SelectItem value="user">User</SelectItem>
          <SelectItem value="admin">Administrator</SelectItem>
        </Select>
        <ErrorNotice error={error} />
        <div className="dialog-actions">
          <Button disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="default" disabled={pending}>
            {pending ? "Creating…" : "Create account"}
          </Button>
        </div>
      </form>
    </section>
  );
}

export function UsersSettings() {
  const identity = useIdentity(),
    cache = useQueryClient(),
    [creating, setCreating] = useState(false),
    [pending, setPending] = useState(false),
    [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [error, setError] = useState<unknown>();
  const users = useQuery({
    queryKey: ["kanvil", "users", query, offset],
    queryFn: async () => {
      const result = await auth.admin.listUsers({
        query: {
          limit: 50,
          offset,
          sortBy: "createdAt",
          sortDirection: "desc",
          ...(query
            ? { searchValue: query, searchField: "email", searchOperator: "contains" }
            : {}),
        },
      });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="mb-0">Users</h2>
        <Modal
          title="Create account"
          trigger="New user"
          open={creating}
          onOpenChange={setCreating}
          busy={pending}
        >
          <AccountAdministration
            pending={pending}
            setPending={setPending}
            onCancel={() => setCreating(false)}
            onCreated={(email) => {
              setCreating(false);
              setQuery("");
              setOffset(0);
              toast.success(`Created ${email}`);
            }}
          />
        </Modal>
      </div>
      <Input
        label="Search users by email"
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOffset(0);
        }}
      />
      <ErrorNotice error={error ?? users.error} />
      {users.isPending ? (
        <Loading />
      ) : !users.data?.users.length ? (
        <EmptyState title={query ? "No matching users" : "No users"} className="py-12" />
      ) : (
        <Table mobileLayout="rows" aria-label="Users">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.data?.users.map((person) => (
              <TableRow key={person.id}>
                <TableCell className="whitespace-normal">
                  <div className="flex min-w-0 items-center gap-3">
                    <UserAvatar name={person.name} image={person.image} />
                    <div className="min-w-0">
                      <p className="mb-0 font-medium">{person.name}</p>
                      <small className="break-all">{person.email}</small>
                    </div>
                  </div>
                </TableCell>
                <TableCell data-label="Role">
                  <Badge variant="secondary">{person.role ?? "user"}</Badge>
                </TableCell>
                <TableCell data-label="Status">{person.banned ? "Disabled" : "Active"}</TableCell>
                <TableCell>
                  {person.id !== identity.id && (
                    <Confirm
                      label={person.banned ? "Enable account" : "Disable account"}
                      icon={person.banned ? <UserRoundCheck /> : <UserRoundX />}
                      danger={!person.banned}
                      description={
                        person.banned
                          ? `Restore sign-in access for ${person.name}?`
                          : `Disable ${person.name}'s sign-in access and revoke their sessions?`
                      }
                      onConfirm={async () => {
                        const result = person.banned
                          ? await auth.admin.unbanUser({ userId: person.id })
                          : await auth.admin.banUser({
                              userId: person.id,
                              banReason: "Disabled by an instance administrator",
                            });
                        if (result.error) {
                          setError(new Error(result.error.message));
                          throw new Error(result.error.message);
                        }
                        await cache.invalidateQueries({ queryKey: ["kanvil", "users"] });
                      }}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {(users.data?.total ?? 0) > 50 && (
        <div className="pagination">
          <span>{users.data?.total} users</span>
          <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Previous users
          </Button>
          <Button
            disabled={offset + 50 >= (users.data?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            Next users
          </Button>
        </div>
      )}
    </section>
  );
}
