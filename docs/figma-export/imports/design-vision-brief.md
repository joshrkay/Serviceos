Design Vision Brief — AI-Native Service Business OS
Purpose

This document is meant to give a product designer or Figma design team a clear vision for the first version of the application.

The product is a multi-tenant, AI-native SaaS operating system for small service businesses. It is designed for owner-operators and very small teams in HVAC, plumbing, and painting. The product should feel less like traditional software and more like an AI office assistant that helps run the business.

The design goal is not to make a feature-heavy enterprise dashboard. The design goal is to create a calm, mobile-friendly, high-trust product that helps overworked small business owners get admin off their plate.

This brief should be used to produce product UX/UI concepts that can later be mapped back into the PRD and turned into user stories.

Core Product Vision

The application should feel like:

an AI office manager

a business control center

a conversational assistant

a lightweight field operations system

The user should feel like they are:

texting or speaking to an assistant

reviewing work, not doing data entry

seeing only what matters right now

staying in control of important decisions

The product should not feel like:

legacy field service software

heavy CRM software

enterprise dispatch software

accounting software

a chatbot toy

The core promise is:

“Run your service business through conversation, with clear visibility and safe review where it matters.”

Primary Users
1. Owner-Operator

This is the main user.

Profile:

runs a small local service business

still does field work

often uses their phone more than a desktop

handles estimates, invoices, scheduling, and customer messages themselves

is overloaded and wants time back

Needs:

fast capture of updates

reminders and follow-ups

easy estimate and invoice creation

clear schedule visibility

confidence that the system will not make expensive mistakes

Primary emotions to design for:

relief

trust

speed

control

2. Technician

Profile:

mostly in the field

needs to see jobs and update progress quickly

does not want long forms

Needs:

assigned jobs

simple quick actions

send photos, notes, and voice updates

minimal typing

Primary emotions:

speed

simplicity

low friction

3. Office/Admin

Profile:

may help with scheduling, estimates, invoices, and customer communication

Needs:

clean operational workflows

review and send drafts

clear status visibility

Primary emotions:

clarity

efficiency

confidence

Product Personality

The assistant and interface should feel:

calm

competent

clear

practical

trustworthy

modern, but not flashy

Avoid:

overly playful AI personality

futuristic sci-fi feel

cluttered dashboards

overuse of cards and widgets

excessive color noise

This should feel like a professional business tool with a smart assistant built in.

Experience Principles
1. Conversation first, UI second

The product should always make conversational input feel natural.

Users should be able to:

type a short message

speak a request

upload a photo

upload a voice note

review the result

The UI exists to:

confirm

correct

review

send

track

manage exceptions

2. Show what needs attention now

The interface should prioritize urgency and next actions over deep navigation.

The most important design question on every screen is:

“What needs the user’s attention right now?”

3. Trust through explanation

AI suggestions should not feel mysterious.

When the product proposes an action, it should show:

what it thinks should happen

what it matched

why it is asking for confirmation when relevant

4. Review-first for risky actions

Anything customer-facing, financial, ambiguous, or rule-changing should feel deliberate and safe.

5. Mobile-first, not mobile-only

The owner and technician experience should feel excellent on mobile. Desktop should feel like a clearer management surface, not a different product.

6. Structured simplicity

The product may be complex underneath, but the user should see a simple, guided experience.

Information Architecture

The product should be organized around a few clear areas.

Home

A split home screen that combines:

assistant entry point

today’s work

pending actions

follow-ups

unpaid invoices

unscheduled jobs

alerts needing attention

This should be the primary landing screen after onboarding.

Assistant

A conversation-centered workspace where users can:

type requests

speak requests

upload photos/documents/voice notes

review AI action proposals

approve, reject, or edit

This should feel like the fastest operational surface in the product.

Jobs

A clean jobs view that shows:

active jobs

status

assigned technician

schedule

linked customer/location

activity history

AI suggestions relevant to that job

Schedule

A basic calendar/dispatch screen that supports:

assignment

date/time changes

quick rescheduling

conversation-triggered schedule changes

lightweight outward calendar sync

Customers / Leads

A lightweight CRM area for:

customer accounts

contacts

service locations

leads

lead and estimate pipeline visibility

duplicate suggestions

Estimates

A focused area to:

review drafts

edit pricing and line items

send to customer

track viewed/approved state

Invoices

A focused area to:

review invoice drafts

send payment links

track unpaid/paid state

see payment events

Settings / Business Setup

A simple settings area for:

tenant profile

team and permissions

approval rules

deposit rules

terminology choices

template preferences

integrations

billing

This should still feel conversational where possible.

Key UX Surfaces to Design

The design team should produce concepts for these screens and flows.

1. Split Home Screen

Must include:

assistant prompt/input area

key pending actions

upcoming jobs

open items requiring review

follow-up reminders

financial attention items

Goal:

feel immediately useful

not feel like a dashboard overload

2. Conversation / Assistant Workspace

Must include:

text input

voice input

attachment input

threaded interaction history

AI proposals

brief reasoning/confidence cues

clear approve/edit/reject controls

Goal:

feel fast and magical

still feel safe and businesslike

3. Job Detail Screen

Must include:

customer/location summary

schedule and technician

status timeline

notes/comments/photos/documents

structured materials/parts used

AI actions relevant to this job

quick invoice/estimate/follow-up actions

Goal:

become the operational source of truth for one job

4. Technician Job View

Must include:

assigned job details

one-tap quick actions

photo upload

voice note capture

note entry

materials/parts capture

Goal:

extremely fast in the field

minimal typing

5. Schedule / Dispatch View

Must include:

calendar/list view

technician assignment

move/reschedule flow

clear job cards

lightweight conflict awareness

Goal:

simple and usable, not enterprise dispatch software

6. Estimate Review and Send Flow

Must include:

estimate summary

editable line items

pricing suggestions

customer send flow

selected document layout

approval tracking

Goal:

fast review

high confidence before send

7. Invoice Review and Send Flow

Must include:

invoice draft

hosted payment flow preparation

card/ACH support messaging

send by SMS/email

payment state visibility

Goal:

remove friction from billing

8. Voice Onboarding Flow

Must include:

conversational setup

voice input / text fallback

rule proposal review

structured config confirmation

business terminology choices

Goal:

setup should feel like talking to an assistant, not filling out forms

9. Owner Dashboard / Attention View

Must include:

open jobs

unscheduled jobs

pending estimates

unpaid invoices

overdue follow-ups

this week’s scheduled work

Goal:

narrow and useful, not heavy analytics

10. Customer Estimate Approval / Invoice Payment Links

Must include:

simple branded estimate page

approve with lightweight name/signature confirmation

simple branded invoice/payment entry point

mobile-friendly design

Goal:

clean, trustworthy customer-facing experiences without a portal

Interaction Patterns
AI proposals

Every important proposal should have:

a title

a clear summary

brief explanation

confidence/ambiguity cue when relevant

actions: approve, edit, reject

Clarification prompts

If confidence is below 99% for entity matching or new record creation, the system should ask focused questions like:

“Is this for Mr. Johnson at 123 Main?”

“Did you mean the plumbing job from today?”

This should feel lightweight, not bureaucratic.

Mixed autonomy

Design should distinguish between:

auto-applied internal updates

review-required risky actions

The user should always understand which one happened.

Smart operational suggestions

Suggestions should appear:

in conversation

on relevant job/estimate/invoice/customer screens

Examples:

invoice draft ready

follow-up recommended

possible duplicate found

quote awaiting response

schedule update suggested

They should not dominate the product.

Language and Localization

The MVP must support:

English

Spanish

Design implications:

UI must be built to handle longer/shorter strings cleanly

voice onboarding should work in both languages

customer communications should work in both languages

terminology customization should still be manageable in both languages

Visual Direction

The visual design should aim for:

high readability

clear hierarchy

soft professionalism

generous spacing

mobile clarity

strong emphasis on primary actions

restrained color use

Suggested feel:

modern SaaS

polished but practical

friendly but serious

Avoid:

dense enterprise tables as the main experience

AI gimmick visuals everywhere

too many bright highlight colors

overly decorative illustrations

Design Constraints

The following constraints come directly from the product decisions and should shape the UX.

The home experience is split: assistant plus operational attention items

The product is web-first with installable PWA support, not native mobile first

Customer-facing pages are link-based, not portal-based

Payments are hosted/enabled externally, but the product owns the operational workflow

Scheduling is simple, not route-optimized

Permissions are role-based with a few toggles, not fully custom

Reporting is lightweight

Notifications are basic operational notifications only

Recurring work is simple, not a full service agreement engine

Parts/materials are structured, but not inventory-aware

Statuses are fixed-core with limited tenant adjustments

What the Figma Output Should Produce

The designer should create a coherent first-pass product system including:

product design direction

navigation model

mobile and desktop concepts

component ideas for AI proposal cards and review states

core user flows

onboarding flow

customer-facing estimate/invoice pages

technician workflow concepts

owner/operator daily workflow concepts

The output should be detailed enough that it can be brought back into the PRD and translated into:

user stories

acceptance criteria

component backlog

engineering priorities

Priority Flows for Design First

If the design team cannot do everything at once, these flows should be designed first:

Split home screen

Assistant / conversation workspace

Job detail screen

Technician mobile job flow

Estimate review + send

Invoice review + payment send

Voice onboarding

Owner attention dashboard

Customer estimate approval page

Customer invoice/payment page

Final Design Goal

When the product is well designed, the owner should feel:

“I can run this business from my phone.”

“I don’t have to remember everything.”

“The assistant gets the work started for me.”

“I still stay in control of the important stuff.”

“This feels built for how my business actually works.”

That is the design standard for the MVP.