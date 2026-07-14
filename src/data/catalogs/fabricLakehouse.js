// Fabric lakehouse catalog — DRAFTED by `npm run fabric:introspect`, then
// REVIEWED and curated by hand, and checked in. Runtime does not auto-discover:
// a schema change is a deliberate re-introspection and review.
//
// Anything not listed here is NOT addressable by the model.
const sql = require("mssql");

// Every table carries a `delFlag` soft-delete column. It is deliberately NOT
// exposed to the model as a selectable/filterable column; instead the compiler
// applies each table's `rowFilter` unconditionally, so soft-deleted rows can
// never be returned by any query.
const NOT_DELETED = (alias) => `${alias}.delFlag = 0`;

const TABLES = {
    patients: {
        sqlName: "dbo.demo_ecw_patients",
        alias: "p",
        description: "Patients: demographics (name, date of birth, gender, city, state).",
        rowFilter: NOT_DELETED("p"),
        columns: {
            PatientID: { sqlName: "p.PatientID", label: "Patient ID", type: "number", description: "Patient identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            FirstName: { sqlName: "p.FirstName", label: "First Name", type: "string", description: "Patient first name.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            LastName: { sqlName: "p.LastName", label: "Last Name", type: "string", description: "Patient last name.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            DOB: { sqlName: "p.DOB", label: "DOB", type: "string", description: "Date of birth (stored as text).", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            Gender: { sqlName: "p.Gender", label: "Gender", type: "string", description: "Gender.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            City: { sqlName: "p.City", label: "City", type: "string", description: "City of residence.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            State: { sqlName: "p.State", label: "State", type: "string", description: "State of residence.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
        },
    },

    providers: {
        sqlName: "dbo.demo_ecw_providers",
        alias: "pr",
        description: "Providers (clinicians): name, specialty, NPI number.",
        rowFilter: NOT_DELETED("pr"),
        columns: {
            ProviderID: { sqlName: "pr.ProviderID", label: "Provider ID", type: "number", description: "Provider identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            FirstName: { sqlName: "pr.FirstName", label: "First Name", type: "string", description: "Provider first name.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            LastName: { sqlName: "pr.LastName", label: "Last Name", type: "string", description: "Provider last name.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            Specialty: { sqlName: "pr.Specialty", label: "Specialty", type: "string", description: "Clinical specialty, e.g. Cardiology.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            NPI: { sqlName: "pr.NPI", label: "NPI", type: "string", description: "National Provider Identifier.", selectable: true, filterable: true, groupable: false, aggregatable: false, sqlType: () => sql.NVarChar(50) },
        },
    },

    encounters: {
        sqlName: "dbo.demo_ecw_enc",
        alias: "e",
        description: "Clinical encounters (visits): which patient saw which provider, when, and the visit type.",
        rowFilter: NOT_DELETED("e"),
        columns: {
            EncounterID: { sqlName: "e.EncounterID", label: "Encounter ID", type: "number", description: "Encounter identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            PatientID: { sqlName: "e.PatientID", label: "Patient ID", type: "number", description: "Patient on the encounter.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            ProviderID: { sqlName: "e.ProviderID", label: "Provider ID", type: "number", description: "Provider on the encounter.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            EncounterDate: { sqlName: "e.EncounterDate", label: "Encounter Date", type: "string", description: "Date of the encounter (text).", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            VisitType: { sqlName: "e.VisitType", label: "Visit Type", type: "string", description: "Type of visit, e.g. Office Visit, Telehealth.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
        },
    },

    appointments: {
        sqlName: "dbo.demo_ecw_appointments",
        alias: "a",
        description: "Scheduled appointments and their status (e.g. Completed, No Show, Cancelled).",
        rowFilter: NOT_DELETED("a"),
        columns: {
            ApptID: { sqlName: "a.ApptID", label: "Appointment ID", type: "number", description: "Appointment identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            PatientID: { sqlName: "a.PatientID", label: "Patient ID", type: "number", description: "Patient on the appointment.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            ProviderID: { sqlName: "a.ProviderID", label: "Provider ID", type: "number", description: "Provider on the appointment.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            ApptDate: { sqlName: "a.ApptDate", label: "Appointment Date", type: "string", description: "Appointment date (text).", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            Status: { sqlName: "a.Status", label: "Status", type: "string", description: "Appointment status, e.g. Completed, No Show.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(100) },
        },
    },

    lab_orders: {
        sqlName: "dbo.demo_ecw_laborder_det",
        alias: "lo",
        description: "Lab orders: the test ordered for an encounter, its LOINC code and order status.",
        rowFilter: NOT_DELETED("lo"),
        columns: {
            OrderID: { sqlName: "lo.OrderID", label: "Order ID", type: "number", description: "Lab order identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            EncounterID: { sqlName: "lo.EncounterID", label: "Encounter ID", type: "number", description: "Encounter the order belongs to.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            PatientID: { sqlName: "lo.PatientID", label: "Patient ID", type: "number", description: "Patient the order is for.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            OrderDate: { sqlName: "lo.OrderDate", label: "Order Date", type: "string", description: "Date the lab was ordered (text).", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            LOINCCode: { sqlName: "lo.LOINCCode", label: "LOINC Code", type: "string", description: "LOINC code of the test.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
            TestName: { sqlName: "lo.TestName", label: "Test Name", type: "string", description: "Name of the lab test, e.g. Hemoglobin A1c.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            OrderStatus: { sqlName: "lo.OrderStatus", label: "Order Status", type: "string", description: "Status of the lab order.", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(100) },
        },
    },

    lab_results: {
        sqlName: "dbo.demo_ecw_labresults",
        alias: "lr",
        description: "Lab results: the value returned for a lab order, its reference range, and whether it is abnormal.",
        rowFilter: NOT_DELETED("lr"),
        columns: {
            ResultID: { sqlName: "lr.ResultID", label: "Result ID", type: "number", description: "Lab result identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            OrderID: { sqlName: "lr.OrderID", label: "Order ID", type: "number", description: "Lab order this result belongs to.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            ResultValue: { sqlName: "lr.ResultValue", label: "Result", type: "string", description: "The result value.", selectable: true, filterable: true, groupable: false, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            ReferenceRange: { sqlName: "lr.ReferenceRange", label: "Reference Range", type: "string", description: "Normal reference range for the test.", selectable: true, filterable: true, groupable: false, aggregatable: false, sqlType: () => sql.NVarChar(200) },
            IsAbnormal: { sqlName: "lr.IsAbnormal", label: "Abnormal", type: "number", description: "1 when the result is outside the reference range, else 0.", selectable: true, filterable: true, groupable: true, aggregatable: true, sqlType: () => sql.BigInt },
            ResultDate: { sqlName: "lr.ResultDate", label: "Result Date", type: "string", description: "Date the result was returned (text).", selectable: true, filterable: true, groupable: true, aggregatable: false, sqlType: () => sql.NVarChar(50) },
        },
    },

    progress_notes: {
        sqlName: "dbo.demo_ecw_progressnotes",
        alias: "pn",
        description: "Clinical progress notes: chief complaint and assessment/plan for an encounter.",
        rowFilter: NOT_DELETED("pn"),
        columns: {
            NoteID: { sqlName: "pn.NoteID", label: "Note ID", type: "number", description: "Note identifier.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            EncounterID: { sqlName: "pn.EncounterID", label: "Encounter ID", type: "number", description: "Encounter the note belongs to.", selectable: true, filterable: true, groupable: false, aggregatable: true, sqlType: () => sql.BigInt },
            ChiefComplaint: { sqlName: "pn.ChiefComplaint", label: "Chief Complaint", type: "string", description: "Reason for the visit in the patient's words.", selectable: true, filterable: true, groupable: false, aggregatable: false, sqlType: () => sql.NVarChar(4000) },
            AssessmentPlan: { sqlName: "pn.AssessmentPlan", label: "Assessment & Plan", type: "string", description: "Clinician's assessment and plan.", selectable: true, filterable: true, groupable: false, aggregatable: false, sqlType: () => sql.NVarChar(4000) },
        },
    },
};

// Reviewed join paths only. Nothing else can be joined.
const JOINS = {
    "encounters->patients": { table: "patients", on: "p.PatientID = e.PatientID" },
    "encounters->providers": { table: "providers", on: "pr.ProviderID = e.ProviderID" },
    "appointments->patients": { table: "patients", on: "p.PatientID = a.PatientID" },
    "appointments->providers": { table: "providers", on: "pr.ProviderID = a.ProviderID" },
    "lab_orders->patients": { table: "patients", on: "p.PatientID = lo.PatientID" },
    "lab_orders->encounters": { table: "encounters", on: "e.EncounterID = lo.EncounterID" },
    "lab_orders->lab_results": { table: "lab_results", on: "lr.OrderID = lo.OrderID" },
    "lab_results->lab_orders": { table: "lab_orders", on: "lo.OrderID = lr.OrderID" },
    "progress_notes->encounters": { table: "encounters", on: "e.EncounterID = pn.EncounterID" },
    "patients->encounters": { table: "encounters", on: "e.PatientID = p.PatientID" },
    "providers->encounters": { table: "encounters", on: "e.ProviderID = pr.ProviderID" },
};

module.exports = {
    name: "healthcare_fabric",
    TABLES,
    JOINS,
    // SCOPE POLICY — required (a catalog with no declared policy fails at startup).
    //
    // The TDS connection is made with the SIGNED-IN USER's own delegated token,
    // so Fabric enforces that user's workspace/table permissions inside the
    // engine: it will not return rows the user is not entitled to see. There is
    // therefore no row-level predicate for us to add — but note this is
    // "enforced by the source", which is materially different from "unscoped".
    // If this source is ever switched to a service principal, this policy MUST
    // be revisited, because every user would then see identical data.
    scope: { policy: "enforced_by_source", table: null, column: null },
};
