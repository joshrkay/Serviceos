import './dispatch-board.css';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { useAuth, useUser } from '@clerk/clerk-react';
import { AlertTriangle } from 'lucide-react';
import { DateNavigation } from '../../components/dispatch/DateNavigation';
import { SummaryStrip } from '../../components/dispatch/SummaryStrip';
import { DispatchFilters, DispatchFilterValues } from '../../components/dispatch/DispatchFilters';
import { UnassignedQueue } from '../../components/dispatch/UnassignedQueue';
import { TechnicianLane } from '../../components/dispatch/TechnicianLane';
import { useDispatchBoard } from '../../hooks/useDispatchBoard';
import { useDispatchBoardStream } from '../../hooks/useDispatchBoardStream';
import { useDispatchPresence } from '../../hooks/useDispatchPresence';
import { AppointmentCardData } from '../../components/dispatch/AppointmentCard';
import {
  ConfirmProposalDialog,
  ProposedProposalType,
  TimeRangeDisplay,
} from '../../components/dispatch/ConfirmProposalDialog';
import { apiFetch } from '../../utils/api-fetch';
import { AddCrewDialog } from '../../components/dispatch/AddCrewDialog';
import { useCreateCrewProposal } from '../../components/dispatch/useCreateCrewProposal';
import {
  useFeasibilityPreview,
  FeasibilityPreviewInput,
} from '../../components/dispatch/useFeasibilityPreview';
import {
  computeProposedSlot,
  SlotPlacement,
} from '../../components/dispatch/compute-proposed-slot';
import {
  laneRenderOrder,
  resolveInsert,
  isSameLaneNoOp,
} from '../../components/dispatch/dispatch-lane-order';
import { emitProposalsChanged, PROPOSALS_CHANGED } from '../../lib/proposal-events';
import { useTenantTimezone } from '../../hooks/useTenantTimezone';
import { tenantWallClockToUtc, utcToTenantWallClock } from '../../utils/formatInTenantTz';
import type { FeasibilityResult } from '../../components/dispatch/feasibility-types';

type DragSourceType = 'queue' | 'lane';

interface DragSource {
  appointmentId: string;
  sourceType: DragSourceType;
  sourceTechnicianId: string | null;
}

type DragOverTarget =
  | { kind: 'lane'; technicianId: string; insertIndex: number }
  | { kind: 'unassigned' }
  | null;

interface PendingDrop {
  source: DragSource;
  targetKind: 'lane' | 'unassigned';
  targetTechnicianId: string | null;
  insertIndex?: number;
  proposalType: ProposedProposalType;
  appointment: AppointmentCardData | null;
  targetDescription: string;
  proposedStart: string;
  proposedEnd: string;
  placement: SlotPlacement;
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `dispatch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDateParam(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// The lane's day-start anchor is the tenant-local working-hours start (or
// 08:00) interpreted in the TENANT tz — not stamped as UTC. The old
// `${boardDate}T${time}:00.000Z` treated tenant wall-clock hours as UTC, so
// an empty-lane drop for a NY tenant proposed 08:00Z instead of 08:00 local.
function dayStartIso(boardDate: string, timezone: string, workingHoursStart?: string): string {
  const time = workingHoursStart?.slice(0, 5) ?? '08:00';
  return tenantWallClockToUtc(boardDate, time, timezone).toISOString();
}

function toDatetimeLocalValue(iso: string, timezone: string): string {
  if (!iso) return '';
  return utcToTenantWallClock(iso, timezone);
}

function fromDatetimeLocalValue(value: string, timezone: string): string {
  if (!value) return '';
  const [datePart, timePart] = value.split('T');
  if (!datePart || !timePart) return '';
  const utc = tenantWallClockToUtc(datePart, timePart, timezone);
  return Number.isNaN(utc.getTime()) ? '' : utc.toISOString();
}

export function DispatchBoard() {
  const timezone = useTenantTimezone();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [filters, setFilters] = useState<DispatchFilterValues>({});
  const dateParam = toDateParam(selectedDate);
  const { data, isLoading, error, refetch } = useDispatchBoard(selectedDate, timezone);
  const { user } = useUser();
  const { userId: clerkUserId } = useAuth();
  const currentUserId = clerkUserId ?? user?.id ?? undefined;

  const [dragSource, setDragSource] = useState<DragSource | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<DragOverTarget>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [isSubmittingProposal, setIsSubmittingProposal] = useState(false);
  const [editedStart, setEditedStart] = useState('');
  const [editedEnd, setEditedEnd] = useState('');
  const [crewDialogAppointmentId, setCrewDialogAppointmentId] = useState<string | null>(null);
  const { removeCrew } = useCreateCrewProposal();

  const { peers: presencePeers, transport: presenceTransport } = useDispatchPresence(
    selectedDate,
    dragSource?.appointmentId ?? null,
  );
  useDispatchBoardStream(dateParam, data?.boardRevision, refetch, {
    // Presence pushes arrive over the WS gateway; skip the SSE-triggered
    // full-board refetch for presence-only changes in that mode.
    presenceViaWs: presenceTransport === 'ws',
  });

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      // Coalesce visibility+focus (both fire on tab return) and bursty
      // proposal events into a single background board refresh.
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void refetch();
      }, 150);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleRefetch();
    };
    // visibilitychange already covers tab return; skip redundant `focus`
    // which double-fired with it and stacked board refetches.
    const onProposalsChanged = () => scheduleRefetch();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(PROPOSALS_CHANGED, onProposalsChanged);
    return () => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(PROPOSALS_CHANGED, onProposalsChanged);
    };
  }, [refetch]);

  const handleDateChange = useCallback((date: Date) => {
    setSelectedDate(date);
  }, []);

  const handleFilterChange = useCallback((newFilters: DispatchFilterValues) => {
    setFilters(newFilters);
  }, []);

  const allAppointments = useMemo<AppointmentCardData[]>(() => {
    if (!data) return [];
    const fromLanes = data.technicianLanes.flatMap((lane) => lane.appointments);
    return [...data.unassignedAppointments, ...fromLanes];
  }, [data]);

  const laneByTechId = useCallback(
    (technicianId: string) =>
      data?.technicianLanes.find((l) => l.technicianId === technicianId),
    [data],
  );

  const previewInput = useMemo<FeasibilityPreviewInput | null>(() => {
    if (!dragSource || dragOverTarget?.kind !== 'lane') return null;
    const appt = allAppointments.find((a) => a.id === dragSource.appointmentId);
    if (!appt) return null;
    const lane = laneByTechId(dragOverTarget.technicianId);
    const renderOrder = laneRenderOrder(lane?.appointments ?? [], filters.status);
    const { withoutDragged, insertIndex } = resolveInsert(
      renderOrder,
      dragSource.appointmentId,
      dragOverTarget.insertIndex,
    );
    const slot = computeProposedSlot({
      appointments: withoutDragged,
      insertIndex,
      dragged: appt,
      dayStartIso: dayStartIso(
        data?.date ?? dateParam,
        timezone,
        lane?.availabilitySummary?.workingHours?.start,
      ),
    });
    if (slot.placement === 'overflow') return null;
    return {
      appointmentId: dragSource.appointmentId,
      proposedTechnicianId: dragOverTarget.technicianId,
      proposedScheduledStart: slot.proposedScheduledStart,
      proposedScheduledEnd: slot.proposedScheduledEnd,
    };
  }, [dragSource, dragOverTarget, allAppointments, laneByTechId, data?.date, dateParam, filters.status, timezone]);

  const { preview: feasibilityPreview } = useFeasibilityPreview(previewInput);

  const confirmPreviewInput = useMemo<FeasibilityPreviewInput | null>(() => {
    if (!pendingDrop || pendingDrop.targetKind !== 'lane' || !pendingDrop.targetTechnicianId) {
      return null;
    }
    if (!pendingDrop.proposedStart || !pendingDrop.proposedEnd) return null;
    return {
      appointmentId: pendingDrop.source.appointmentId,
      proposedTechnicianId: pendingDrop.targetTechnicianId,
      proposedScheduledStart: pendingDrop.proposedStart,
      proposedScheduledEnd: pendingDrop.proposedEnd,
    };
  }, [pendingDrop]);

  const { preview: confirmFeasibilityPreview } = useFeasibilityPreview(confirmPreviewInput);

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

  const handleAddCrew = useCallback((appointmentId: string) => {
    setCrewDialogAppointmentId(appointmentId);
  }, []);

  const crewExcludeIds = useCallback(
    (appointmentId: string): string[] => {
      if (!data) return [];
      const lane = data.technicianLanes.find((l) =>
        l.appointments.some((a) => a.id === appointmentId),
      );
      const appt = findAppointment(appointmentId);
      const co = (appt?.coAssignees ?? []).map((c) => c.technicianId);
      return lane ? [lane.technicianId, ...co] : co;
    },
    [data, findAppointment],
  );

  const handleRemoveCoAssignee = useCallback(
    async (appointmentId: string, technicianId: string) => {
      const appt = findAppointment(appointmentId);
      const result = await removeCrew({
        appointmentId,
        technicianId,
        appointmentVersion: appt?.updatedAt,
      });
      if (result.success) {
        toast.success('Crew removal proposed — pending review');
        emitProposalsChanged();
        void refetch();
      } else if (result.error === 'STALE') {
        toast.warning('Someone else updated this appointment — refresh and try again.');
        void refetch();
      } else {
        const msg = typeof result.error === 'string' ? result.error : 'Could not remove crew member';
        toast.error(msg);
      }
    },
    [findAppointment, removeCrew, refetch],
  );

  const openConfirmWithSlot = useCallback(
    (target: {
      kind: 'lane' | 'unassigned';
      technicianId: string | null;
      insertIndex?: number;
    }) => {
      if (!dragSource) return;
      const appointment = findAppointment(dragSource.appointmentId);
      if (!appointment) return;

      if (target.kind === 'lane' && target.technicianId && target.insertIndex !== undefined) {
        const lane = laneByTechId(target.technicianId);
        const renderOrder = laneRenderOrder(lane?.appointments ?? [], filters.status);
        if (
          dragSource.sourceTechnicianId === target.technicianId &&
          isSameLaneNoOp(renderOrder, dragSource.appointmentId, target.insertIndex)
        ) {
          toast.info(
            'Use the arrows on the card to reorder, or drag to another technician lane.',
          );
          return;
        }
      }

      let proposalType: ProposedProposalType;
      let targetDescription: string;
      let proposedStart = appointment.scheduledStart;
      let proposedEnd = appointment.scheduledEnd;
      let placement: SlotPlacement = 'gap';

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

      if (target.kind === 'lane' && target.technicianId && target.insertIndex !== undefined) {
        const lane = laneByTechId(target.technicianId);
        const renderOrder = laneRenderOrder(lane?.appointments ?? [], filters.status);
        const { withoutDragged, insertIndex } = resolveInsert(
          renderOrder,
          dragSource.appointmentId,
          target.insertIndex,
        );
        const slot = computeProposedSlot({
          appointments: withoutDragged,
          insertIndex,
          dragged: appointment,
          dayStartIso: dayStartIso(
            data?.date ?? dateParam,
            timezone,
            lane?.availabilitySummary?.workingHours?.start,
          ),
        });
        placement = slot.placement;
        if (slot.placement !== 'overflow') {
          proposedStart = slot.proposedScheduledStart;
          proposedEnd = slot.proposedScheduledEnd;
        }
      }

      setEditedStart(toDatetimeLocalValue(proposedStart, timezone));
      setEditedEnd(toDatetimeLocalValue(proposedEnd, timezone));
      setPendingDrop({
        source: dragSource,
        targetKind: target.kind,
        targetTechnicianId: target.technicianId,
        insertIndex: target.insertIndex,
        proposalType,
        appointment,
        targetDescription,
        proposedStart,
        proposedEnd,
        placement,
      });
    },
    [dragSource, findAppointment, findTechnicianName, laneByTechId, data?.date, dateParam, filters.status, timezone],
  );

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

  const handleDragStartFromQueue = useCallback((e: React.DragEvent, appointmentId: string) => {
    e.dataTransfer.setData('text/plain', appointmentId);
    e.dataTransfer.effectAllowed = 'move';
    setDragSource({
      appointmentId,
      sourceType: 'queue',
      sourceTechnicianId: null,
    });
  }, []);

  const handleDragOverUnassigned = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTarget({ kind: 'unassigned' });
  }, []);

  const handleDragOverGap = useCallback(
    (technicianId: string) => (insertIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDragOverTarget({ kind: 'lane', technicianId, insertIndex });
    },
    [],
  );

  const handleDragLeaveGap = useCallback(
    () => (e: React.DragEvent) => {
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

  const handleDropOnGap = useCallback(
    (technicianId: string) => (insertIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      setDragOverTarget(null);
      if (!dragSource) return;
      openConfirmWithSlot({ kind: 'lane', technicianId, insertIndex });
      setDragSource(null);
    },
    [dragSource, openConfirmWithSlot],
  );

  const handleDropOnUnassigned = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOverTarget(null);
      if (!dragSource) return;
      if (dragSource.sourceType === 'queue') {
        setDragSource(null);
        return;
      }
      openConfirmWithSlot({ kind: 'unassigned', technicianId: null });
      setDragSource(null);
    },
    [dragSource, openConfirmWithSlot],
  );

  const handleReorderWithinLane = useCallback(
    (technicianId: string, appointmentId: string, fromIndex: number, toIndex: number) => {
      if (fromIndex === toIndex) return;
      const lane = laneByTechId(technicianId);
      if (!lane) return;
      // fromIndex/toIndex index the rendered (filtered + sorted) lane, matching
      // what TechnicianLane's arrows report.
      const renderOrder = laneRenderOrder(lane.appointments, filters.status);
      const appointment = renderOrder[fromIndex];
      const neighbor = renderOrder[toIndex];
      if (!appointment || !neighbor) return;

      // Repack into the target slot rather than copying the neighbour's exact
      // times — proposing identical times always trips the feasibility overlap
      // check and leaves Confirm permanently disabled. `toIndex` is the desired
      // final position, expressed directly against the dragged-removed list.
      const withoutDragged = renderOrder.filter((a) => a.id !== appointmentId);
      const slot = computeProposedSlot({
        appointments: withoutDragged,
        insertIndex: toIndex,
        dragged: appointment,
        dayStartIso: dayStartIso(
          data?.date ?? dateParam,
          timezone,
          lane.availabilitySummary?.workingHours?.start,
        ),
      });
      const proposedStart =
        slot.placement === 'overflow' ? appointment.scheduledStart : slot.proposedScheduledStart;
      const proposedEnd =
        slot.placement === 'overflow' ? appointment.scheduledEnd : slot.proposedScheduledEnd;

      setPendingDrop({
        source: {
          appointmentId,
          sourceType: 'lane',
          sourceTechnicianId: technicianId,
        },
        targetKind: 'lane',
        targetTechnicianId: technicianId,
        proposalType: 'reschedule_appointment',
        appointment,
        targetDescription:
          toIndex > fromIndex
            ? `Move after ${neighbor.customerName ?? 'neighbor'}`
            : `Move before ${neighbor.customerName ?? 'neighbor'}`,
        proposedStart,
        proposedEnd,
        placement: slot.placement,
      });
      setEditedStart(toDatetimeLocalValue(proposedStart, timezone));
      setEditedEnd(toDatetimeLocalValue(proposedEnd, timezone));
    },
    [laneByTechId, filters.status, data?.date, dateParam, timezone],
  );

  const submitProposal = useCallback(async () => {
    if (!pendingDrop) return;
    setIsSubmittingProposal(true);

    const { source, targetTechnicianId, proposalType, appointment } = pendingDrop;
    const proposedStart =
      pendingDrop.placement === 'overflow'
        ? fromDatetimeLocalValue(editedStart, timezone)
        : pendingDrop.proposedStart;
    const proposedEnd =
      pendingDrop.placement === 'overflow'
        ? fromDatetimeLocalValue(editedEnd, timezone)
        : pendingDrop.proposedEnd;

    const idempotencyKey = generateIdempotencyKey();
    let payload: Record<string, unknown>;
    let summary: string;

    if (proposalType === 'reassign_appointment') {
      payload = {
        appointmentId: source.appointmentId,
        ...(source.sourceTechnicianId ? { fromTechnicianId: source.sourceTechnicianId } : {}),
        toTechnicianId: targetTechnicianId,
        scheduledStart: proposedStart,
        scheduledEnd: proposedEnd,
        reason: 'Reassigned via dispatch board drag-and-drop',
      };
      summary = 'Reassign appointment to a different technician';
    } else if (proposalType === 'reschedule_appointment') {
      payload = {
        appointmentId: source.appointmentId,
        newScheduledStart: proposedStart,
        newScheduledEnd: proposedEnd,
        reason: 'Rescheduled via dispatch board drag-and-drop',
      };
      summary = 'Reschedule appointment within technician lane';
    } else {
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
          toast.warning('Someone else updated this appointment — refresh and try again.');
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

      const json = (await response.json().catch(() => null)) as { id?: string } | null;
      const proposalId = json?.id;
      const link = proposalId ? `/inbox?proposal=${proposalId}` : '/inbox';

      toast.success('Proposal created — pending review', {
        action: {
          label: 'Review',
          onClick: () => window.location.assign(link),
        },
      });
      emitProposalsChanged();
      void refetch();
      setPendingDrop(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Could not create proposal: ${msg}`);
    } finally {
      setIsSubmittingProposal(false);
    }
  }, [pendingDrop, editedStart, editedEnd, refetch, timezone]);

  const cancelPendingDrop = useCallback(() => {
    if (isSubmittingProposal) return;
    setPendingDrop(null);
  }, [isSubmittingProposal]);

  const updatePendingTimes = useCallback((start: string, end: string) => {
    setEditedStart(start);
    setEditedEnd(end);
    const isoStart = fromDatetimeLocalValue(start, timezone);
    const isoEnd = fromDatetimeLocalValue(end, timezone);
    // Preserve the existing placement. The time-edit inputs only render while
    // placement is 'overflow'; forcing 'gap' here unmounts them on the first
    // keystroke, making it impossible to edit the second field.
    setPendingDrop((prev) =>
      prev
        ? {
            ...prev,
            proposedStart: isoStart,
            proposedEnd: isoEnd,
          }
        : null,
    );
  }, [timezone]);

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

  const isQueueDropTarget = dragOverTarget?.kind === 'unassigned';

  const confirmTimeRange: TimeRangeDisplay | undefined =
    pendingDrop?.appointment && pendingDrop.proposedStart
      ? {
          fromStart: pendingDrop.appointment.scheduledStart,
          fromEnd: pendingDrop.appointment.scheduledEnd,
          toStart: pendingDrop.proposedStart,
          toEnd: pendingDrop.proposedEnd,
        }
      : undefined;

  // Prefer live WS presence (fresher than the board snapshot); fall back to
  // the `editing` field embedded in the board payload (HTTP-fallback mode).
  const pendingDropApptId = pendingDrop?.appointment?.id;
  const livePeerEditing = pendingDropApptId
    ? presencePeers.find(
        (peer) =>
          peer.mode === 'dragging' &&
          peer.appointmentId === pendingDropApptId &&
          peer.userId !== currentUserId,
      )
    : undefined;
  const snapshotEditing =
    pendingDrop?.appointment?.editing &&
    pendingDrop.appointment.editing.userId !== currentUserId
      ? pendingDrop.appointment.editing
      : undefined;
  const editingPeer =
    presenceTransport === 'ws' ? livePeerEditing : (livePeerEditing ?? snapshotEditing);
  const presenceWarning = editingPeer
    ? `${editingPeer.displayName} may be editing this appointment.`
    : undefined;

  const dialogFeasibility: FeasibilityResult | null =
    confirmFeasibilityPreview ?? (pendingDrop ? feasibilityPreview : null);

  return (
    <div className="dispatch-board" data-testid="dispatch-board">
      <div className="dispatch-board__header">
        <div>
          <h1>Dispatch Board</h1>
          {conflictIds.size > 0 && (
            <p
              className="text-xs text-amber-600 flex items-center gap-1 mt-0.5"
              data-testid="dispatch-conflict-banner"
            >
              <AlertTriangle size={11} />
              {conflictIds.size} scheduling conflict{conflictIds.size !== 1 ? 's' : ''} on this day
            </p>
          )}
        </div>
        <DateNavigation selectedDate={selectedDate} onDateChange={handleDateChange} />
      </div>

      {data?.summary && <SummaryStrip summary={data.summary} />}

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
              onDragOver={handleDragOverUnassigned}
              onDragLeave={handleDragLeaveGap()}
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
                isDragOver={dragOverTarget?.kind === 'lane' && dragOverTarget.technicianId === lane.technicianId}
                activeDropIndex={
                  dragOverTarget?.kind === 'lane' && dragOverTarget.technicianId === lane.technicianId
                    ? dragOverTarget.insertIndex
                    : null
                }
                onDragOverGap={handleDragOverGap(lane.technicianId)}
                onDragLeaveGap={handleDragLeaveGap()}
                onDropGap={handleDropOnGap(lane.technicianId)}
                onReorderWithinLane={(appointmentId, fromIndex, toIndex) =>
                  handleReorderWithinLane(lane.technicianId, appointmentId, fromIndex, toIndex)
                }
                conflictIds={conflictIds}
                currentUserId={currentUserId}
                onAddCrew={handleAddCrew}
                onRemoveCoAssignee={handleRemoveCoAssignee}
                dragPreview={
                  dragOverTarget?.kind === 'lane' &&
                  dragOverTarget.technicianId === lane.technicianId &&
                  feasibilityPreview
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
        timeRange={confirmTimeRange}
        feasibility={dialogFeasibility}
        presenceWarning={presenceWarning}
        allowTimeEdit={pendingDrop?.placement === 'overflow'}
        editedStart={editedStart}
        editedEnd={editedEnd}
        onEditedTimesChange={updatePendingTimes}
        isSubmitting={isSubmittingProposal}
        onConfirm={submitProposal}
        onCancel={cancelPendingDrop}
      />

      {crewDialogAppointmentId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          data-testid="add-crew-modal"
        >
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setCrewDialogAppointmentId(null)}
          />
          <div className="relative z-10 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <AddCrewDialog
              appointmentId={crewDialogAppointmentId}
              appointmentVersion={findAppointment(crewDialogAppointmentId)?.updatedAt}
              excludeTechnicianIds={crewExcludeIds(crewDialogAppointmentId)}
              onCreated={() => {
                setCrewDialogAppointmentId(null);
                toast.success('Crew member proposed — pending review');
                emitProposalsChanged();
                void refetch();
              }}
              onCancel={() => setCrewDialogAppointmentId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
