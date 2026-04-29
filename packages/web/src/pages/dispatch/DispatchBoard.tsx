import React, { useState, useCallback, useMemo } from 'react';
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
        proposalType = 'cancel_assignment';
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
      // cancel_assignment
      payload = {
        appointmentId: source.appointmentId,
        reason: 'Removed from technician via dispatch board drag-and-drop',
        cancellationType: 'scheduling_conflict',
      };
      summary = 'Cancel appointment assignment';
    }

    try {
      const response = await apiFetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposalType,
          payload,
          summary,
          idempotencyKey,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        toast.error(`Could not create proposal${text ? `: ${text}` : ''}`);
        return;
      }

      const json = (await response.json().catch(() => null)) as
        | { id?: string }
        | null;
      const proposalId = json?.id;
      const link = proposalId ? `/proposals/${proposalId}` : '/proposals';

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
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Could not create proposal: ${msg}`);
    } finally {
      setIsSubmittingProposal(false);
      setPendingDrop(null);
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
