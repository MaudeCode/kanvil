import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { auth, useIdentity } from "../data.tsx";
import { Button, Confirm, ErrorNotice, Input, Loading, Modal, Select, SelectItem } from "../ui.tsx";
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
export function AccountAdministration() {
  const cache = useQueryClient();
  const [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false),
    [created, setCreated] = useState("");
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
      setCreated(`Created ${result.data.user.email}`);
      await cache.invalidateQueries({ queryKey: ["kanvil", "users"] });
      form.reset();
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section>
      <h2>Create account</h2>
      <form
        onSubmit={(event) => {
          void create(event);
        }}
      >
        <Input label="Name" name="name" required maxLength={120} />
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
        <Button type="submit" disabled={pending}>
          Create account
        </Button>
        {created && <p role="status">{created}</p>}
      </form>
    </section>
  );
}

export function UsersSettings() {
  const identity = useIdentity(),
    cache = useQueryClient(),
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
        <Modal title="Create account" trigger="New user">
          <AccountAdministration />
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
      ) : (
        <Table>
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
                <TableCell>
                  <div className="flex items-center gap-3">
                    <UserAvatar name={person.name} image={person.image} />
                    <div>
                      <p className="mb-0 font-medium">{person.name}</p>
                      <small>{person.email}</small>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{person.role ?? "user"}</Badge>
                </TableCell>
                <TableCell>{person.banned ? "Disabled" : "Active"}</TableCell>
                <TableCell>
                  {person.id !== identity.id && (
                    <Confirm
                      label={person.banned ? "Enable account" : "Disable account"}
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
