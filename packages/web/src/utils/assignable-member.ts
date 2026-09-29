/**
 * #1463 — assignment pickers offer only ACTIVE members. GET /api/users returns
 * suspended (deactivated) members too, so the Team page can show and
 * reactivate them; a picker must not offer them because the API refuses the
 * assignment. A missing `status` is the column default, 'active'.
 */
export function isAssignableMember(user: { status?: string | null }): boolean {
  return (user.status ?? 'active') === 'active';
}
