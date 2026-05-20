import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { DateNavigation } from '../../components/dispatch/DateNavigation';
import { SummaryStrip } from '../../components/dispatch/SummaryStrip';
import { DispatchFilters, DispatchFilterValues } from '../../components/dispatch/DispatchFilters';
import { UnassignedQueue } from '../../components/dispatch/UnassignedQueue';
import { TechnicianLane } from '../../components/dispatch/TechnicianLane';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import { AppointmentCardData } from '../../components/dispatch/AppointmentCard';
import {
  ConfirmProposalDialog,
  ProposedProposalType,
} from '../../components/dispatch/ConfirmProposalDialog';
import { apiFetch } from '../../utils/api-fetch';
import {
  useFeasibilityPreview,
  FeasibilityPreviewInput,
} from '../../components/dispatch/useFeasibilityPreview';

type DragSourceType = 'queue' | 'lane';

interface DragSource {
  appointmentId: string;
  sourceType: DragSourceType;
  sourceTechnicianId: string | null;
}

interface PendingDrop {
  source: DragSource;
  targetKind: 'lane' | 'unassigned';
  targetTechnicianId: string | null;
  proposalType: ProposedProposalType;
  appointment: AppointmentCardData | null;
  targetDescription: string;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function DispatchBoard() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [filters, setFilters] = useState<DispatchFilterValues>({});
  const { data, isLoading, error, refetch } = useDispatchBoard(selectedDate);

  // Drag state — purely visual / intent. Never mutates appointment positions.
  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);

  // Pending drop awaiting human confirmation. The appointment does NOT move
  // until the user confirms AND the proposal is approved upstream.
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [isSubmittingProposal, setIsSubmittingProposal] = useState(false);

  // P6-027 — refetch when the tab regains focus or the document
  // becomes visible. Catches the case where a dispatcher approves a
  // proposal in another tab (the proposals review screen) and
  // returns to the board expecting the updated lane state.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    };
    const onFocus = () => {
      void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refetch]);

  const handleDateChange = useCallback((date: Date) => {
    setSelectedDate(date);
  }, []);

  const handleFilterChange = useCallback((newFilters: DispatchFilterValues) => {
    setFilters(newFilters);
  }, []);

  // ── Lookup helpers ────────────────────────────────────────────────────
  const allAppointments = useMemo<AppointmentCardData[]>(() => {
    if (!data) return [];
    const fromLanes = data.technicianLanes.flatMap((lane) => lane.appointments);
    return [...data.unassignedAppointments, ...fromLanes];
  }, [data]);

  // ── Live feasibility preview during drag ──────────────────────────────
  // Builds a debounced read-only query so the hovered lane can render
  // red/yellow/green drop-zone feedback without committing a proposal.
  const previewInput = useMemo<FeasibilityPreviewInput | null>(() => {
    if (!dragSource) return null;
    if (!dragOverTarget || dragOverTarget === '__unassigned__') return null;
    const appt = allAppointments.find((a) => a.id === dragSource.appointmentId);
    if (!appt) return null;
    return {
      appointmentId: dragSource.appointmentId,
      proposedTechnicianId: dragOverTarget,
      proposedScheduledStart: appt.scheduledStart,
      proposedScheduledEnd: appt.scheduledEnd,
    };
  }, [dragSource, dragOverTarget, allAppointments]);
  const { preview: feasibilityPreview } = useFeasibilityPreview(previewInput);

  /**
   * P6-026 — set of appointment ids whose time range overlaps another
   * booking on the same technician's lane. Pairwise scan within each
   * lane (O(n²) per lane, but lanes are small in practice — typically
   * < 12 appointments per technician per day). Unassigned appointments
   * don't conflict among themselves because no technician owns them.
   * Two appointments overlap iff a.start < b.end AND b.start < a.end
   * (strict inequality so back-to-back bookings don't flag).
   */
  const conflictIds = useMemo<ReadonlySet<string>>(() => {
    if (!data) return new Set<string>();
    const conflicts = new Set<string>();
    for (const lane of data.technicianLanes) {
      const sorted = [...lane.appointments].sort(
        (a, b) =>
          new Date(a.scheduledStart).getTime() - new Date(b.scheduledStart).getTime(),
      );
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          const aStart = new Date(a.scheduledStart).getTime();
          const aEnd = new Date(a.scheduledEnd).getTime();
          const bStart = new Date(b.scheduledStart).getTime();
          const bEnd = new Date(b.scheduledEnd).getTime();
          if (aStart < bEnd && bStart < aEnd) {
            conflicts.add(a.id);
            conflicts.add(b.id);
          }
        }
      }
    }
    return conflicts;
  }, [data]);

  const findAppointment = useCallback(
    (id: string): AppointmentCardData | null =>
      allAppointments.find((a) => a.id === id) ?? null,
    [allAppointments],
  );

  const findTechnicianName = useCallback(
    (technicianId: string | null): string | null => {
      if (!technicianId || !data) return null;
      return (
        data.technicianLanes.find((lane) => lane.technicianId === technicianId)
          ?.technicianName ?? null
      );
    },
    [data],
  );

  // ── Drag handlers ─────────────────────────────────────────────────────
  const handleDragStartFromLane = useCallback(
    (technicianId: string) =>
      (e: React.DragEvent, appointmentId: string) => {
        e.dataTransfer.setData('text/plain', appointmentId);
        e.dataTransfer.effectAllowed = 'move';
        setDragSource({
          appointmentId,
          sourceType: 'lane',
          sourceTechnicianId: technicianId,
        });
      },
    [],
  );

  const handleDragStartFromQueue = useCallback(
    (e: React.DragEvent, appointmentId: string) => {
      e.dataTransfer.setData('text/plain', appointmentId);
      e.dataTransfer.effectAllowed = 'move';
      setDragSource({
        appointmentId,
        sourceType: 'queue',
        sourceTechnicianId: null,
      });
    },
    [],
  );

  const handleDragOverTarget = useCallback(
    (targetId: string) =>
      (e: React.DragEvent) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDragOverTarget(targetId);
      },
    [],
  );

  const handleDragLeaveTarget = useCallback(
    () =>
      (e: React.DragEvent) => {
        // Ignore events that fire when entering child elements
        if (
          e.currentTarget &&
          e.relatedTarget &&
          (e.currentTarget as Node).contains(e.relatedTarget as Node)
        ) {
          return;
        }
        setDragOverTarget(null);
      },
    [],
  );

  const classifyAndOpenConfirm = useCallback(
    (target: { kind: 'lane' | 'unassigned'; technicianId: string | null }) => {
      if (!dragSource) return;
      const appointment = findAppointment(dragSource.appointmentId);

      let proposalType: ProposedProposalType;
      let targetDescription: string;

      if (target.kind === 'unassigned') {
        proposalType = 'cancel_appointment';
        targetDescription = 'Remove from technician — return to unassigned queue';
      } else if (
        dragSource.sourceTechnicianId &&
        dragSource.sourceTechnicianId === target.technicianId
      ) {
        proposalType = 'reschedule_appointment';
        const techName = findTechnicianName(target.technicianId);
        targetDescription = techName
          ? `Reschedule within ${techName}'s lane`
          : 'Reschedule within current lane';
      } else {
        proposalType = 'reassign_appointment';
        const techName = findTechnicianName(target.technicianId);
        targetDescription = techName
          ? `Reassign to ${techName}`
          : 'Reassign to selected technician';
      }

      setPendingDrop({
        source: dragSource,
        targetKind: target.kind,
        targetTechnicianId: target.technicianId,
        proposalType,
        appointment,
        targetDescription,
      });
    },
    [dragSource, findAppointment, findTechnicianName],
  );

  const handleDropOnLane = useCallback(
    (technicianId: string) =>
      (e: React.DragEvent) => {
        e.preventDefault();
        // Reset visual drag state synchronously; the pending dialog drives
        // confirmation. The appointment's source position is NEVER mutated.
        setDragOverTarget(null);
        if (!dragSource) return;
        // Same source-tech, same drop-target tech, AND no time selection — we
        // still surface the reschedule dialog. The actual time payload would
        // be picked from a follow-up edit (out of scope here); for now the
        // confirmation dialog explains the proposal and the user can cancel.
        classifyAndOpenConfirm({ kind: 'lane', technicianId });
        setDragSource(null);
      },
    [classifyAndOpenConfirm, dragSource],
  );

  const handleDropOnUnassigned = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverTarget(null);
      if (!dragSource) return;
      // Drops from the unassigned queue back onto itself are no-ops.
      if (dragSource.sourceType === 'queue') {
        setDragSource(null);
        return;
      }
      classifyAndOpenConfirm({ kind: 'unassigned', technicianId: null });
      setDragSource(null);
    },
    [classifyAndOpenConfirm, dragSource],
  );

  // ── Proposal creation (only on user confirm) ──────────────────────────
  const submitProposal = useCallback(async () => {
    if (!pendingDrop) return;
    setIsSubmittingProposal(true);

    const { source, targetKind, targetTechnicianId, proposalType, appointment } = pendingDrop;
    const idempotencyKey = generateIdempotencyKey();

    let payload: Record<string, unknown>;
    let summary: string;

    if (proposalType === 'reassign_appointment') {
      payload = {
        appointmentId: source.appointmentId,
        ...(source.sourceTechnicianId
          ? { fromTechnicianId: source.sourceTechnicianId }
          : {}),
        toTechnicianId: targetTechnicianId,
        ...(appointment
          ? {
              scheduledStart: appointment.scheduledStart,
              scheduledEnd: appointment.scheduledEnd,
            }
          : {}),
        reason: 'Reassigned via dispatch board drag-and-drop',
      };
      summary = 'Reassign appointment to a different technician';
    } else if (proposalType === 'reschedule_appointment') {
      payload = {
        appointmentId: source.appointmentId,
        // Same-lane drop without explicit time — keep the existing window.
        // The proposal review screen lets the approver tweak before approval.
        newScheduledStart: appointment?.scheduledStart ?? '',
        newScheduledEnd: appointment?.scheduledEnd ?? '',
        reason: 'Rescheduled via dispatch board drag-and-drop',
      };
      summary = 'Reschedule appointment within technician lane';
    } else {
      // cancel_appointment
      payload = {
        appointmentId: source.appointmentId,
        reason: 'Removed from technician via dispatch board drag-and-drop',
        cancellationType: 'scheduling_conflict',
      };
      summary = 'Cancel appointment assignment';
    }

    const appointmentVersion = appointment?.updatedAt;

    try {
      const response = await apiFetch('/api/proposals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(appointmentVersion ? { 'If-Match': appointmentVersion } : {}),
        },
        body: JSON.stringify({
          proposalType,
          payload,
          summary,
          idempotencyKey,
          ...(appointmentVersion ? { appointmentVersion } : {}),
        }),
      });

      if (!response.ok) {
        if (response.status === 409) {
          toast.warning(
            'Someone else updated this appointment — refresh and try again.',
          );
          void refetch();
          return;
        }
        if (response.status === 422) {
          const body = (await response.json().catch(() => ({}))) as {
            blocking?: Array<{ message?: string }>;
          };
          const reason = body.blocking?.[0]?.message ?? 'feasibility check failed';
          toast.error(`Cannot schedule: ${reason}`);
          return;
        }
        const text = await response.text().catch(() => '');
        toast.error(`Could not create proposal${text ? `: ${text}` : ''}`);
        return;
      }

      const json = (await response.json().catch(() => null)) as
        | { id?: string }
        | null;
      const proposalId = json?.id;
      const link = proposalId ? `/inbox?proposal=${proposalId}` : '/inbox';

      toast.success('Proposal created — pending review', {
        action: {
          label: 'Review',
          onClick: () => {
            // Defer to react-router navigation if available; fall back to
            // window.location to stay framework-agnostic in tests.
            window.location.assign(link);
          },
        },
      });
      // P6-027 — refetch the board after a successful proposal POST.
      // Auto-approved proposals (high-confidence schedule changes that
      // clear the auto-approve threshold) execute immediately upstream,
      // so the next refetch picks up the new state. Proposals that
      // queue for human review return unchanged data — refetch is a
      // no-op in that case but keeps the UI consistent if the proposal
      // gets approved+executed in another tab while this one is open.
      void refetch();
      // Only dismiss the dialog on success. On error we keep `pendingDrop`
      // so the user can retry without re-performing the drag.
      setPendingDrop(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Could not create proposal: ${msg}`);
    } finally {
      setIsSubmittingProposal(false);
    }
  }, [pendingDrop]);

  const cancelPendingDrop = useCallback(() => {
    if (isSubmittingProposal) return;
    setPendingDrop(null);
  }, [isSubmittingProposal]);

  // ── Filtering / projection ────────────────────────────────────────────
  const filteredLanes = data?.technicianLanes.filter((lane) => {
    if (filters.technicianIds && filters.technicianIds.length > 0) {
      return filters.technicianIds.includes(lane.technicianId);
    }
    return true;
  }) ?? [];

  const filterAppointmentsByStatus = (appointments: AppointmentCardData[]) => {
    if (!filters.status) return appointments;
    return appointments.filter((a) => a.status === filters.status);
  };

  const technicians = data?.technicianLanes.map((lane) => ({
    id: lane.technicianId,
    name: lane.technicianName,
  })) ?? [];

  const isQueueDropTarget = dragOverTarget === '__unassigned__';

  return (
    <div className="dispatch-board" data-testid="dispatch-board">
      <div className="dispatch-board__header">
        <h1>Dispatch Board</h1>
        <DateNavigation selectedDate={selectedDate} onDateChange={handleDateChange} />
      </div>

      {data?.summary && (
        <SummaryStrip summary={data.summary} />
      )}

      <DispatchFilters
        technicians={technicians}
        activeFilters={filters}
        onFilterChange={handleFilterChange}
      />

      {isLoading ? (
        <div className="dispatch-board__loading" data-testid="dispatch-board-loading">
          Loading dispatch board...
        </div>
      ) : error ? (
        <div className="dispatch-board__error" data-testid="dispatch-board-error">
          <p>{error}</p>
          <button onClick={refetch}>Retry</button>
        </div>
      ) : (
        <div className="dispatch-board__content">
          <div className="dispatch-board__sidebar">
            <UnassignedQueue
              appointments={filterAppointmentsByStatus(data?.unassignedAppointments ?? [])}
              onDragStart={handleDragStartFromQueue}
              isDragOver={isQueueDropTarget}
              onDragOver={handleDragOverTarget('__unassigned__')}
              onDragLeave={handleDragLeaveTarget()}
              onDrop={handleDropOnUnassigned}
              conflictIds={conflictIds}
            />
          </div>

          <div className="dispatch-board__lanes" data-testid="dispatch-board-lanes">
            {filteredLanes.map((lane) => (
              <TechnicianLane
                key={lane.technicianId}
                technician={{
                  id: lane.technicianId,
                  name: lane.technicianName,
                }}
                appointments={filterAppointmentsByStatus(lane.appointments)}
                onDragStart={handleDragStartFromLane(lane.technicianId)}
                isDragOver={dragOverTarget === lane.technicianId}
                onDragOver={handleDragOverTarget(lane.technicianId)}
                onDragLeave={handleDragLeaveTarget()}
                onDrop={handleDropOnLane(lane.technicianId)}
                conflictIds={conflictIds}
                dragPreview={
                  dragOverTarget === lane.technicianId && feasibilityPreview
                    ? { targetTechnicianId: lane.technicianId, preview: feasibilityPreview }
                    : null
                }
              />
            ))}
            {filteredLanes.length === 0 && (
              <div className="dispatch-board__empty" data-testid="dispatch-board-empty">
                No technician lanes to display
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmProposalDialog
        open={pendingDrop !== null}
        proposalType={pendingDrop?.proposalType ?? null}
        appointmentSummary={
          pendingDrop?.appointment
            ? `${pendingDrop.appointment.customerName} — ${pendingDrop.appointment.jobSummary}`
            : undefined
        }
        targetDescription={pendingDrop?.targetDescription}
        isSubmitting={isSubmittingProposal}
        onConfirm={submitProposal}
        onCancel={cancelPendingDrop}
      />
    </div>
  );
}
