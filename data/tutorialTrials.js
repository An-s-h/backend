/**
 * Pre-loaded hypertension trial results for the Trials page tutorial.
 * Returned by GET /api/search/trials/tutorial so the tour always shows the same content
 * without calling ClinicalTrials.gov or using search limits.
 */
export const TUTORIAL_TRIALS = [
  {
    id: "NCT-TUT-001",
    _id: "NCT-TUT-001",
    title: "Lifestyle Modification and Blood Pressure Control in Adults with Hypertension",
    status: "RECRUITING",
    phase: "PHASE3",
    conditions: ["Hypertension", "High Blood Pressure"],
    description:
      "This study evaluates the effect of combined lifestyle interventions (diet, exercise, stress management) on blood pressure control in adults with stage 1 hypertension. Participants will be followed for 12 months.",
    conditionDescription: "Hypertension and blood pressure management.",
    location: "Toronto, Ontario, Canada; Vancouver, British Columbia, Canada",
    locations: ["Toronto, Ontario, Canada", "Vancouver, British Columbia, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Adults 18-75 years with diagnosed hypertension. Exclusion: Secondary hypertension, recent MI or stroke.",
      minimumAge: "18 Years",
      maximumAge: "75 Years",
      gender: "All",
    },
    contacts: [
      { name: "Study Coordinator", role: "Contact", email: "hypertension-study@example.org", phone: "+1-416-555-0100" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-001",
    matchPercentage: 92,
    matchExplanation: "Strong match based on your interest in hypertension and location.",
  },
  {
    id: "NCT-TUT-002",
    _id: "NCT-TUT-002",
    title: "Resistant Hypertension: Renal Denervation Versus Medical Therapy",
    status: "RECRUITING",
    phase: "PHASE3",
    conditions: ["Resistant Hypertension", "Hypertension"],
    description:
      "A randomized trial comparing catheter-based renal denervation with intensified medical therapy in patients with resistant hypertension. Primary outcome is change in 24-hour ambulatory systolic blood pressure at 6 months.",
    conditionDescription: "Resistant hypertension treatment options.",
    location: "Montreal, Quebec, Canada",
    locations: ["Montreal, Quebec, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Resistant hypertension on 3+ antihypertensive agents. Exclusion: Secondary hypertension, renal artery anatomy unsuitable for denervation.",
      minimumAge: "21 Years",
      maximumAge: "80 Years",
      gender: "All",
    },
    contacts: [
      { name: "Principal Investigator", role: "Principal Investigator", email: "pi-cardio@example.org" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-002",
    matchPercentage: 88,
    matchExplanation: "Relevant for hypertension with focus on resistant cases.",
  },
  {
    id: "NCT-TUT-003",
    _id: "NCT-TUT-003",
    title: "Salt Restriction and Blood Pressure in Adults with Prehypertension",
    status: "RECRUITING",
    phase: "PHASE2",
    conditions: ["Prehypertension", "Hypertension", "Blood Pressure"],
    description:
      "Investigates whether a low-sodium diet with behavioral support can prevent progression from prehypertension to hypertension. Duration 18 months with clinic and home blood pressure monitoring.",
    conditionDescription: "Diet and blood pressure prevention.",
    location: "Calgary, Alberta, Canada; Edmonton, Alberta, Canada",
    locations: ["Calgary, Alberta, Canada", "Edmonton, Alberta, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Systolic 120-139 or diastolic 80-89 mmHg, no current antihypertensive medication. Exclusion: Diabetes, CKD, pregnancy.",
      minimumAge: "18 Years",
      maximumAge: "70 Years",
      gender: "All",
    },
    contacts: [
      { name: "Trial Contact", role: "Contact", email: "salt-study@example.org" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-003",
    matchPercentage: 85,
    matchExplanation: "Matches hypertension and lifestyle intervention focus.",
  },
  {
    id: "NCT-TUT-004",
    _id: "NCT-TUT-004",
    title: "Digital Health Coaching for Hypertension Self-Management",
    status: "RECRUITING",
    phase: "PHASE2",
    conditions: ["Hypertension", "Self-Management"],
    description:
      "Evaluates a smartphone-based coaching app plus home blood pressure monitoring versus usual care for improving blood pressure control and medication adherence in adults with hypertension.",
    conditionDescription: "Digital tools for hypertension management.",
    location: "Toronto, Ontario, Canada; Ottawa, Ontario, Canada",
    locations: ["Toronto, Ontario, Canada", "Ottawa, Ontario, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Diagnosed hypertension, smartphone user, age 18+. Exclusion: Inability to use app, severe comorbidities.",
      minimumAge: "18 Years",
      maximumAge: "N/A",
      gender: "All",
    },
    contacts: [
      { name: "Enrollment Contact", role: "Contact", email: "digital-hbp@example.org", phone: "+1-613-555-0200" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-004",
    matchPercentage: 82,
    matchExplanation: "Good fit for hypertension with interest in self-management.",
  },
  {
    id: "NCT-TUT-005",
    _id: "NCT-TUT-005",
    title: "Blood Pressure Targets in Older Adults with Hypertension (STEP-Canada)",
    status: "NOT_YET_RECRUITING",
    phase: "PHASE3",
    conditions: ["Hypertension", "Aged", "Blood Pressure"],
    description:
      "Multicenter trial comparing intensive (systolic < 120 mmHg) versus standard (systolic < 140 mmHg) blood pressure targets in adults 70+ with hypertension. Primary outcome: composite of cardiovascular events and mortality.",
    conditionDescription: "Blood pressure targets in older adults.",
    location: "Vancouver, British Columbia, Canada; Hamilton, Ontario, Canada",
    locations: ["Vancouver, British Columbia, Canada", "Hamilton, Ontario, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Age 70+, systolic 140-190 on 0-3 medications. Exclusion: Prior stroke, heart failure, dialysis.",
      minimumAge: "70 Years",
      maximumAge: "N/A",
      gender: "All",
    },
    contacts: [
      { name: "Study Team", role: "Contact", email: "step-canada@example.org" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-005",
    matchPercentage: 78,
    matchExplanation: "Relevant for hypertension in older adults.",
  },
  {
    id: "NCT-TUT-006",
    _id: "NCT-TUT-006",
    title: "Hypertension in Pregnancy: Prevention of Preeclampsia with Low-Dose Aspirin",
    status: "RECRUITING",
    phase: "PHASE3",
    conditions: ["Hypertensive Disorder of Pregnancy", "Preeclampsia", "Hypertension"],
    description:
      "Randomized placebo-controlled trial of low-dose aspirin started in early pregnancy for prevention of preeclampsia in women at increased risk. Primary outcome: incidence of preeclampsia before 37 weeks.",
    conditionDescription: "Hypertension and pregnancy.",
    location: "Toronto, Ontario, Canada; Montreal, Quebec, Canada",
    locations: ["Toronto, Ontario, Canada", "Montreal, Quebec, Canada"],
    eligibility: {
      criteria:
        "Inclusion: Singleton pregnancy, gestational age < 16 weeks, at least one risk factor for preeclampsia. Exclusion: Contraindication to aspirin, multiple gestation.",
      minimumAge: "18 Years",
      maximumAge: "N/A",
      gender: "Female",
    },
    contacts: [
      { name: "Maternal Health Research", role: "Contact", email: "pregnancy-bp@example.org" },
    ],
    clinicalTrialsGovUrl: "https://clinicaltrials.gov/study/NCT-TUT-006",
    matchPercentage: 75,
    matchExplanation: "Hypertension focus with pregnancy-specific eligibility.",
  },
];
