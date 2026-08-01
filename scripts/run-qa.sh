#!/bin/bash

##############################################################################
# QA Runner Script
# Purpose: Set up and track manual QA runs every 2-3 days
# Usage: ./scripts/run-qa.sh [--today] [--tester NAME] [--env staging|prod]
##############################################################################

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
TESTER="${TESTER:-}"
ENVIRONMENT="${ENVIRONMENT:-staging}"
RUN_DATE="$(date +%Y-%m-%d)"
RUN_TIME="$(date +%s)"

# Check if running from repo root
if [ ! -f "CLAUDE.md" ]; then
    echo -e "${RED}Error: Please run from repository root${NC}"
    exit 1
fi

##############################################################################
# Helper Functions
##############################################################################

print_header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"
}

print_section() {
    echo -e "\n${YELLOW}→ $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

confirm() {
    local prompt="$1"
    local response
    read -p "$(echo -e ${YELLOW}$prompt${NC} " (y/n): ")" response
    [[ "$response" == "y" || "$response" == "Y" ]]
}

##############################################################################
# Main QA Setup
##############################################################################

main() {
    print_header "QA RUN SETUP — $RUN_DATE"

    # 1. Get tester name if not provided
    if [ -z "$TESTER" ]; then
        print_section "Tester Information"
        read -p "Enter tester name/initials: " TESTER
        if [ -z "$TESTER" ]; then
            print_error "Tester name required"
            exit 1
        fi
    fi
    print_success "Tester: $TESTER"

    # 2. Confirm environment
    print_section "Environment"
    echo "Selected environment: $ENVIRONMENT"
    if ! confirm "Proceed with $ENVIRONMENT?"; then
        read -p "Enter environment (staging/prod): " ENVIRONMENT
        if [[ ! "$ENVIRONMENT" =~ ^(staging|prod)$ ]]; then
            print_error "Invalid environment"
            exit 1
        fi
    fi
    print_success "Environment: $ENVIRONMENT"

    # 3. Verify application is running
    print_section "Pre-Flight Checks"
    check_app_health

    # 4. Create results file from template
    print_section "Creating Results File"
    create_results_file

    # 5. Display testing roadmap
    print_section "QA Testing Roadmap"
    show_testing_roadmap

    # 6. Show previous run summary (for comparison)
    print_section "Comparison to Prior Run"
    show_prior_run_summary

    # 7. Final setup
    print_section "Ready to Begin"
    echo -e "${GREEN}QA run initialized for $RUN_DATE${NC}"
    echo ""
    echo "📋 Detailed testing checklist: docs/QA_CHECKLIST.md"
    echo "📝 Results template: docs/qa-results-$RUN_DATE.md"
    echo "📊 Master log: docs/QA_LOG.md"
    echo ""
    echo "💡 Tips:"
    echo "   • Test on desktop (1920px), tablet (768px), and mobile (375px)"
    echo "   • Use Chrome, Firefox, and Safari when possible"
    echo "   • Be brutally honest — record every failure"
    echo "   • Compare against prior runs to catch regressions"
    echo "   • Screenshots/videos help with complex failures"
    echo ""
    echo "After testing, update QA_LOG.md with results:"
    echo "   1. Fill in pass rate, failure counts in the summary table"
    echo "   2. Document regressions in regression tracking section"
    echo "   3. Update feature area health scores"
    echo ""
    if confirm "Start testing now?"; then
        open_testing_resources
    else
        echo -e "${BLUE}Testing can be started manually whenever ready.${NC}"
    fi
}

##############################################################################
# Pre-Flight Checks
##############################################################################

check_app_health() {
    # Check if web app is running
    if [ "$ENVIRONMENT" = "staging" ]; then
        local WEB_URL="http://localhost:3000"
        local API_URL="http://localhost:3001"
    else
        local WEB_URL="https://app.serviceos.com"
        local API_URL="https://api.serviceos.com"
    fi

    echo "Checking web app at $WEB_URL..."
    if curl -s -I "$WEB_URL" > /dev/null 2>&1; then
        print_success "Web app is reachable"
    else
        print_error "Web app is not reachable at $WEB_URL"
        if confirm "Continue anyway?"; then
            echo "⚠️  Will proceed but some tests may fail due to connectivity"
        else
            exit 1
        fi
    fi

    echo "Checking API at $API_URL..."
    if curl -s -I "$API_URL" > /dev/null 2>&1; then
        print_success "API is reachable"
    else
        print_error "API is not reachable at $API_URL"
        if confirm "Continue anyway?"; then
            echo "⚠️  Will proceed but API tests may fail"
        else
            exit 1
        fi
    fi
}

##############################################################################
# Create Results File
##############################################################################

create_results_file() {
    local RESULTS_FILE="docs/qa-results-$RUN_DATE.md"

    if [ -f "$RESULTS_FILE" ]; then
        print_error "Results file already exists: $RESULTS_FILE"
        if confirm "Overwrite existing file?"; then
            rm "$RESULTS_FILE"
        else
            echo "Using existing file: $RESULTS_FILE"
            return
        fi
    fi

    # Copy template and substitute placeholders
    cp docs/qa-results-template.md "$RESULTS_FILE"

    # Replace placeholders with actual values
    sed -i.bak "s/\[DATE: YYYY-MM-DD\]/$RUN_DATE/g" "$RESULTS_FILE"
    sed -i.bak "s/\[Name\/initials\]/$TESTER/g" "$RESULTS_FILE"
    sed -i.bak "s/\[Production\/Staging\]/$(echo $ENVIRONMENT | sed 's/./\U&/g')/g" "$RESULTS_FILE"
    sed -i.bak "s/\[X\]/[TBD]/g" "$RESULTS_FILE"

    rm "$RESULTS_FILE.bak"

    print_success "Created results file: $RESULTS_FILE"
    print_info "Open this file to track test results as you go"
}

##############################################################################
# Show Testing Roadmap
##############################################################################

show_testing_roadmap() {
    cat << 'EOF'
QA Test Execution Order (by priority):

  CRITICAL PATH (Test first):
  1. Authentication & Sign In — Can users log in?
  2. Dashboard — Does the main interface load and work?
  3. Appointments — Can technicians create/view appointments?
  4. Estimates — Can estimates be created and sent?
  5. Invoices — Can invoices be created and paid?
  6. Voice/Telephony — Do inbound calls work?
  7. Payment Processing — Can customers actually pay?

  CORE WORKFLOWS (Test next):
  8. SMS Messaging — Are SMS notifications sent/received?
  9. Customer Management — Can customers be added and managed?
  10. Jobs & Dispatch — Can jobs be tracked and dispatched?
  11. Settings — Can configurations be changed?
  12. Security & RLS — Is data properly isolated by tenant?

  POLISH & EDGE CASES (If time permits):
  13. Error Handling — Are error messages clear and helpful?
  14. Performance — Are page loads acceptable?
  15. Mobile Responsiveness — Does it work on 375px width?
  16. Accessibility — Are tap targets ≥44px?
  17. Reports & Analytics — Do reports generate correctly?
  18. AI & Proposals — Are AI-generated proposals reasonable?

  Estimated Time per Area:
  • Critical path: 2-3 hours
  • Core workflows: 2-3 hours
  • Polish & edges: 1-2 hours
  • Total: 5-8 hours for complete run

EOF
}

##############################################################################
# Show Prior Run Summary
##############################################################################

show_prior_run_summary() {
    # Find most recent prior QA log entry
    local PRIOR_DATE=""
    local PRIOR_PASS_RATE=""

    # Try to extract from QA_LOG.md
    if [ -f "docs/QA_LOG.md" ]; then
        PRIOR_DATE=$(grep -E "^\| [0-9]{4}-[0-9]{2}-[0-9]{2}" docs/QA_LOG.md | tail -1 | awk -F'|' '{print $2}' | xargs)
        if [ ! -z "$PRIOR_DATE" ] && [ "$PRIOR_DATE" != "$RUN_DATE" ]; then
            PRIOR_PASS_RATE=$(grep -E "^\| $PRIOR_DATE" docs/QA_LOG.md | awk -F'|' '{print $5}' | xargs)
            echo "Last QA run: $PRIOR_DATE (Pass rate: $PRIOR_PASS_RATE)"
            echo "⚠️  Look for regressions vs. that run"
        fi
    fi
}

##############################################################################
# Open Testing Resources
##############################################################################

open_testing_resources() {
    echo ""
    print_section "Opening Testing Resources"

    # Open files in default editor/browser
    if command -v code &> /dev/null; then
        echo "Opening in VS Code..."
        code docs/QA_CHECKLIST.md docs/qa-results-$RUN_DATE.md docs/QA_LOG.md &
    elif command -v open &> /dev/null; then
        echo "Opening files..."
        open docs/QA_CHECKLIST.md &
        open docs/qa-results-$RUN_DATE.md &
    elif command -v xdg-open &> /dev/null; then
        echo "Opening files..."
        xdg-open docs/QA_CHECKLIST.md &
        xdg-open docs/qa-results-$RUN_DATE.md &
    fi

    print_success "Files opened. Begin testing!"
}

##############################################################################
# Post-Run Functions
##############################################################################

finalize_qa_run() {
    print_header "QA RUN COMPLETE"

    print_section "Summary"
    echo "Results file: docs/qa-results-$RUN_DATE.md"
    echo ""
    echo "📋 Next steps:"
    echo "   1. Review the results file — ensure all details are filled in"
    echo "   2. Copy the summary section to docs/QA_LOG.md summary table"
    echo "   3. Document any regressions in QA_LOG.md"
    echo "   4. Update feature health scores if changed"
    echo "   5. Commit the results: git add docs/qa-results-$RUN_DATE.md docs/QA_LOG.md"
    echo "   6. Make a PR for review"
    echo ""
    echo "🔗 Resources:"
    echo "   • Detailed results: docs/qa-results-$RUN_DATE.md"
    echo "   • Master log: docs/QA_LOG.md"
    echo "   • Template for next run: docs/qa-results-template.md"
}

##############################################################################
# Parse Arguments
##############################################################################

while [[ $# -gt 0 ]]; do
    case $1 in
        --tester)
            TESTER="$2"
            shift 2
            ;;
        --env|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        --today)
            RUN_DATE="$(date +%Y-%m-%d)"
            shift
            ;;
        --finalize)
            finalize_qa_run
            exit 0
            ;;
        --help|-h)
            cat << 'EOF'
QA Runner Script

Usage: ./scripts/run-qa.sh [OPTIONS]

Options:
  --tester NAME          Set tester name (default: prompt)
  --env staging|prod     Set environment (default: staging)
  --today               Use today's date for results file
  --finalize            Show post-run instructions
  --help                Show this help message

Examples:
  ./scripts/run-qa.sh --tester "Alice" --env staging
  ./scripts/run-qa.sh --today
  ./scripts/run-qa.sh --finalize

Environment:
  The script will:
  1. Verify tester information
  2. Confirm environment (staging or production)
  3. Check that the app is running
  4. Create a results file from the template
  5. Display the testing roadmap
  6. Show comparison to prior run

Results:
  All QA results are stored in: docs/qa-results-YYYY-MM-DD.md
  Master tracking log: docs/QA_LOG.md

EOF
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

##############################################################################
# Run Main
##############################################################################

main
