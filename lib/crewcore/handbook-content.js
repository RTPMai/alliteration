// lib/crewcore/handbook-content.js — the Employee Handbook, in-app.
//
// Source: Employee_Handbook.docx, uploaded Aug 2026. This is the CURRENT
// handbook per Ryan's explicit confirmation — it superseded the Wix site's
// Handbook page, which was stale (missing Live Print/Decorate event pay,
// USERRA, phone/headphone policy, health & safety, and performance review
// sections that are in the docx; the docx also dropped the Wix page's
// standalone Prohibited Behaviors / Separation of Employment / Employment
// Disclaimers sections as their own top-level entries, though most of that
// content survives folded into other sections below).
//
// This is TEXT CONTENT, not configuration — there is no "validate a
// handbook" function because nothing here is user-submitted. Editing the
// handbook means editing this file and redeploying, same as any other
// static shell content (ERRORS_ENDPOINT naming, DEPARTMENTS, etc.). If that
// friction becomes a problem — frequent policy tweaks — moving this to KV
// with an admin editor is a reasonable follow-up, but isn't built now
// because the docx changes rarely enough that a deploy is the right amount
// of ceremony.
//
// Structure: an ordered list of sections, each with a stable "id" (used for
// deep links / anchor scrolling in the UI) and a "title", holding one or
// more "blocks". A block is a paragraph ({ p: "..." }), a sub-heading
// ({ h: "..." }), or a labeled list ({ list: ["...", "..."] }). Kept
// deliberately simple — this is rendered, not parsed back into structured
// policy logic anywhere.
//
// ESM. Do NOT convert to module.exports.

export const HANDBOOK_UPDATED = "2026-08"; // uploaded month, shown in the UI

export const HANDBOOK_SECTIONS = [
  {
    id: "about-us",
    title: "About Us",
    blocks: [
      { p: "P&M Apparel is a woman-owned, third-generation family business specializing in custom apparel and promo products, located in Polk City, Iowa. Our roots are literally Mom and Pop Shop; we started in the basement of Phyllis and Melvin (the P&M) as a new career after farming and remodeling homes most of their lives. Their daughter Kay took over the business a few years after it moved to Polk City and two of her children, Megan and Ryan, joined the ranks as business grew. Ryan and Megan took over ownership in 2023." },
      { p: "Since 1987 we have been providing unparalleled service to small businesses, groups, organizations and teams throughout Central Iowa. And even though our area of operation has expanded to the entire United States as well as other countries, we haven't forgotten what has brought us to this point, our commitment to customer service second to none." },
      { p: "This site is intended to be an internal resource for new and existing employees. It covers the basics from company hierarchy to onboarding documents and job descriptions. This is a living site and will be updated as necessary." }
    ]
  },
  {
    id: "our-purpose",
    title: "Our Purpose",
    blocks: [
      { p: "Every client that comes to us is looking to communicate an idea, a brand, an event, an ideology, and they need a device to communicate with. That's often apparel, but can also be logo design, promotional products, marketing materials, any number of things." },
      { p: "Our purpose is to listen to the client and create solutions that are specific to that client. We know what we are and we know what we're not. We are not custom ink, we are not our competitors, we are not interested in selling the cheapest shirt we can, we are not a copy and paste experience where a client gets the exact same products, art, etc. as their competitor. We ARE listeners who develop products unique to each client. Our clients come to us trusting that we care about what they are trying to communicate as much as they do. We are quality experts that are passionate about what we do and the clients coming to us are looking for high quality, highly personalized, custom experiences." }
    ]
  },
  {
    id: "our-niche",
    title: "Our Niche",
    blocks: [
      { p: "We often say sometimes a shirt is more than a shirt. Every day, we're talking to clients who may be coming in for a shirt, but really, the shirt represents a fundraiser for a loved one with an illness. Or maybe it's someone that took a leap and is investing their savings into a small business. Or the shirt represents the child they would die for playing the sport that gives them life." },
      { p: "The stories behind the shirt are what we are creating, the shirt is just the conduit for the story. Likewise, we are not just delivering a shirt, we are representing the dreams that are so wildly beyond what Phyllis and Melvin had in their basement so many years ago." },
      { p: "So we don't take ourselves too seriously, we know we print shirts and are not brain surgeons, that a t-shirt won't \u201cruin Christmas.\u201d But we also know what came before us and that our clients are trusting us with their story." }
    ]
  },
  {
    id: "employment-basics",
    title: "Employment Basics",
    blocks: [
      { h: "Introductory Period" },
      { p: "All new employees will serve a 90-day introductory period. During this time, performance, attendance, and overall fit with the company will be evaluated. Successful completion of the introductory period does not guarantee continued employment, as employment remains at will." },
      { h: "Employee Classification" },
      { p: "Employees are classified as full-time, part-time, seasonal, or temporary. Full-time employees are regularly scheduled to work at least 30 hours per week. Part-time employees are regularly scheduled to work less than 30 hours per week. Seasonal and temporary employees are hired for a set project or limited time period." },
      { h: "Work Eligibility" },
      { p: "In compliance with federal law, all employees must complete the Form I-9 and provide valid documentation to verify their eligibility to work in the United States." }
    ]
  },
  {
    id: "work-hours-and-pay",
    title: "Work Hours and Pay",
    blocks: [
      { h: "Workweek and Standard Hours" },
      { list: [
        "Front office: Monday through Friday, 8:00 a.m. to 5:00 p.m.",
        "Production: Monday through Friday, 8:00 a.m. to 4:30 p.m."
      ] },
      { h: "Pay Periods" },
      { p: "Employees are paid twice per month, on the 1st and the 16th. If payday falls on a weekend or holiday, pay will be issued on the last business day prior." },
      { h: "Timekeeping" },
      { p: "Hourly employees must clock in upon arrival, clock out for lunch, clock back in after lunch, and clock out at the end of their shift. Employees are also required to clock out if they leave the premises for any reason other than a 15-minute break." },
      { h: "Breaks and Meal Periods" },
      { p: "Hourly employees are provided two paid 15-minute breaks per shift. These breaks may not be combined or used to leave early. Lunch periods are unpaid and generally last 30 minutes. Salary employees get an hour lunch." },
      { h: "Overtime" },
      { p: "Overtime for hourly employees is paid at one and one-half times the regular hourly rate for hours worked over 40 in a workweek. All overtime must be approved in advance by the employee's direct supervisor." }
    ]
  },
  {
    id: "attendance",
    title: "Attendance",
    blocks: [
      { h: "Purpose" },
      { p: "The purpose of this policy is to set forth P&M Apparel's policy and procedures for handling employee absences and tardiness to promote the efficient operation of the company and minimize unscheduled absences." },
      { h: "Policy" },
      { p: "Punctual and regular attendance is an essential responsibility of each employee at P&M Apparel. Employees are expected to report to work as scheduled, on time and prepared to start working. Employees also are expected to remain at work for their entire work schedule. Late arrival, early departure or other absences from scheduled hours are disruptive and must be avoided. This policy does not apply to leave provided as a reasonable accommodation under the Americans with Disabilities Act (ADA)." },
      { h: "Absence" },
      { p: "\u201cAbsence\u201d is defined as the failure of an employee to report for work when they are scheduled to work." },
      { h: "Disciplinary Action" },
      { p: "Excessive absenteeism is defined as three or more occurrences of unexcused absence in a 30-day period and will result in disciplinary action. 12 occurrences of unexcused absence in a 12-month period are considered grounds for termination." },
      { h: "Job Abandonment" },
      { p: "Any employee who fails to report to work for a period of two days or more without notifying his or her supervisor will be considered to have abandoned the job and voluntarily terminated the employment relationship." },
      { h: "Inclement Weather" },
      { p: "P&M Apparel will be following the operating status of the federal government during inclement weather. Prior to normal starting time it will be announced if P&M Apparel will be closed. All full-time employees will be paid for such time off. Part-time employees will be paid if normally scheduled to work that day and only for those hours which the employee would normally work. If no announcement is made, P&M Apparel will be open and all employees will be expected to make reasonable efforts to get to work. Employees unable to arrive for work due to inclement weather will be charged one (1) day of PTO. If no PTO is available, nonexempt employees will not be paid for the day. All employees who are unable to report to work should call their direct supervisor, and one director, and report their absence 30 minutes prior to the start of their work day." },
      { p: "On days when weather conditions worsen as the day progresses, P&M Apparel may decide to close the office early. Employees will be expected to remain at work until the appointed closing time. Employees may choose to leave earlier than the appointed closing time at their discretion. If employees choose to leave early, their direct supervisor may charge up to one-half (1/2) day of PTO." }
    ]
  },
  {
    id: "paid-time-off",
    title: "Paid Time Off",
    blocks: [
      { p: "New hires will be given 10 days of PTO (pro-rated for the year in which they start). After a full year of employment, employees will be given 15 days of PTO starting January 1st. PTO does not rollover at the end of the year, and is renewed January 1st." },
      { h: "Live Events Payment and Paid Time Off Accrual" },
      { p: "P&M Apparel has several events a year we Live Print or Decorate. People who volunteer to work these events are compensated in the following manner:" },
      { list: [
        "Hourly Staff are paid time and a half their normal rate for the event duration",
        "Salary Staff earn 1 hour of PTO per hour of the event"
      ] },
      { h: "Paid Holidays" },
      { p: "P&M Apparel follows the federal holiday calendar. If a holiday falls on a weekend, the observed day will be recognized. Eligible employees will receive holiday pay." },
      { h: "Bereavement Leave" },
      { p: "Employees may take up to 5 paid days off in the event of the death of an immediate family member. Familial deaths outside immediate family will be given 2 paid days off. Deaths outside of the family will be granted 1 paid day off. Additional unpaid leave may be granted at the discretion of management." },
      { h: "Jury Duty" },
      { p: "Employees summoned for jury duty will be granted time off to fulfill their civic obligation. Employees may use PTO during this period or take the leave unpaid. Employees must provide a copy of the jury summons to their supervisor." },
      { h: "Military Leave" },
      { p: "P&M Apparel complies with the Uniformed Services Employment and Reemployment Rights Act (USERRA). Employees who are called to military service will be granted leave in accordance with federal law and reinstated to their position upon return, as required." },
      { h: "Parental Leave" },
      { p: "Employees may use accrued PTO for parental leave related to the birth or adoption of a child. Additional unpaid leave may be granted in compliance with applicable state or federal law." },
      { p: "PTO tracking and requests are handled through QuickBooks, not through CrewCore. See the Payroll Hub link on the internal site for time off requests." }
    ]
  },
  {
    id: "workplace-policies",
    title: "Workplace Policies",
    blocks: [
      { h: "Technology and Communication" },
      { p: "Company-provided technology, including computers, internet access, and email, is intended for business use. Personal use should be limited and must not interfere with work responsibilities. Employees should use good judgment when accessing the internet or sending email. Inappropriate, illegal, or offensive content is prohibited." },
      { h: "Personal Phones and Headphones" },
      { p: "Personal phone use should be limited to breaks or urgent matters. Employees should avoid extended personal calls during work hours. Headphones are permitted but must be worn in one ear only so employees remain able to communicate with coworkers." },
      { h: "Conflict of Interest and Outside Work" },
      { p: "Employees should avoid outside work that competes with P&M Apparel or conflicts with their responsibilities here. Outside employment within the decorated apparel industry is discouraged. Employees are expected to disclose any outside business activities that may pose a conflict of interest." },
      { h: "Confidentiality" },
      { p: "Customer data, vendor pricing, and internal processes are considered confidential and must not be shared outside of P&M Apparel. Misuse of company information or disclosure of confidential materials may result in disciplinary action up to and including termination." }
    ]
  },
  {
    id: "dress-code",
    title: "Dress Code",
    blocks: [
      { h: "Purpose" },
      { p: "The P&M Apparel dress code policy is designed to help us all provide a consistent professional appearance to our customers and colleagues. Our appearance reflects on ourselves and the company. The goal is to be sure that we maintain a positive appearance and not to offend customers, clients, or colleagues." },
      { h: "Dress Code Violations" },
      { p: "Managers or supervisors are expected to inform employees when they are violating the dress code. Employees in violation are expected to immediately correct the issue. This may include having to leave work to change clothes." },
      { p: "Repeated violations or violations that have major repercussions may result in disciplinary action being taken up to and including termination." },
      { h: "Apparel Stipend" },
      { p: "Front Office staff receive $250 per year and Production staff receive $150 per year toward P&M Apparel branded items, for use by the employee and not family, friends, etc. See the Stipend tab in CrewCore for your balance and spend history." }
    ]
  },
  {
    id: "health-and-safety",
    title: "Health and Safety",
    blocks: [
      { h: "General Safety" },
      { p: "Employees are expected to follow all safety guidelines, including safe operation of presses, embroidery equipment, chemicals, and tools. Closed-toed shoes are required in production areas. Employees must use protective equipment when provided." },
      { h: "Accident Reporting" },
      { p: "Any workplace accident, injury, or unsafe condition must be reported immediately to a supervisor or director." }
    ]
  },
  {
    id: "performance-and-development",
    title: "Performance and Development",
    blocks: [
      { h: "Performance Reviews" },
      { p: "Performance reviews are conducted annually during our two on one meetings. Reviews are intended to provide feedback, set goals, and identify opportunities for growth. Additional reviews may be held at the discretion of supervisors." },
      { h: "Training and Development" },
      { p: "P&M Apparel provides training to help employees succeed in their roles, including system training (such as Chipply or Printavo), equipment training, and workflow best practices. Employees are encouraged to seek additional development opportunities and bring ideas for improvement to management." },
      { h: "Promotions and Transfers" },
      { p: "Promotions and transfers are based on performance, skills, and business needs. Open positions may be posted internally, and employees are encouraged to apply if interested." }
    ]
  },
  {
    id: "prohibited-behaviors",
    title: "Prohibited Behaviors in the Workplace",
    blocks: [
      { p: "To ensure a safe, productive, and respectful environment for all employees and visitors, the following behaviors are strictly prohibited within the workplace premises. Violation of any of these policies may result in disciplinary action, up to and including termination of employment." },
      { h: "Use of Illegal Substances" },
      { p: "Possession, use, distribution, or sale of illegal drugs or controlled substances on company property is prohibited. Reporting to work under the influence of illegal drugs or alcohol is not permitted. Smoking, vaping, or using tobacco products in the P&M Apparel building is strictly prohibited." },
      { h: "Weapons" },
      { p: "Possession of weapons of any kind on company property, unless expressly permitted by law and authorized by management, is forbidden." },
      { h: "Theft and Vandalism" },
      { p: "Theft, deliberate destruction, defacement, or misuse of company or employee property is strictly prohibited." },
      { h: "Breach of Confidentiality" },
      { p: "Unauthorized use or disclosure of proprietary information or confidential business matters, including personal information of employees and clients, is against company policy." },
      { h: "Misuse of Company Resources" },
      { p: "Company resources, including internet access, email systems, and other electronic resources, are provided for job-related purposes. Misuse or unauthorized personal use of these resources is not allowed. Printing, copying, or downloading unauthorized material on company equipment is prohibited." },
      { h: "Failure to Comply with Safety Guidelines" },
      { p: "Ignoring safety protocols, tampering with safety devices, or engaging in reckless behavior that poses a risk to self or others is unacceptable. Failure to report accidents, injuries, or unsafe conditions may result in disciplinary actions." },
      { h: "Inappropriate Use of Social Media" },
      { p: "Posting confidential company information, disparaging remarks about the company, employees, clients, or partners on social media platforms is prohibited. Use of social media should not interfere with work commitments and must comply with our Social Media Policy." },
      { p: "This list is not exhaustive, and employees are expected to exercise common sense and good judgment in their behavior within the workplace." }
    ]
  },
  {
    id: "progressive-discipline",
    title: "Progressive Discipline Policy",
    blocks: [
      { h: "Purpose" },
      { p: "P&M Apparel's progressive discipline policy and procedures are designed to provide a structured corrective action process to improve and prevent a recurrence of undesirable employee behavior and performance issues." },
      { p: "Outlined below are the steps of P&M Apparel's progressive discipline policy and procedures. P&M Apparel reserves the right to combine or skip steps depending on the facts of each situation and the nature of the offense. Some of the factors that will be considered are whether the offense is repeated despite coaching, counseling or training; the employee's work record; and the impact the conduct and performance issues have on the organization. Nothing in this policy provides any contractual rights regarding employee discipline or counseling, nor should anything in this policy be read or construed as modifying or altering the employment-at-will relationship between P&M Apparel and its employees." },
      { h: "Appeals Process" },
      { p: "Employees will have the opportunity to present information to dispute information management has used to issue disciplinary action. The purpose of this process is to provide insight into extenuating circumstances that may have contributed to the employee's performance or conduct issues while allowing for an equitable solution." },
      { p: "If the employee does not present this information during any of the step meetings, he or she will have five business days after each of those meetings to present such information." },
      { h: "Performance and Conduct Issues Not Subject to Progressive Discipline" },
      { p: "Behavior that is illegal is not subject to progressive discipline and may result in immediate termination. Such behavior may be reported to local law enforcement authorities." },
      { p: "Similarly, theft, substance abuse, intoxication, fighting and other acts of violence at work are also not subject to progressive discipline and may be grounds for immediate termination." },
      { h: "Documentation" },
      { p: "The employee will be provided copies of all progressive discipline documentation. The employee will be asked to sign copies of this documentation attesting to his or her receipt and understanding of the corrective action outlined in these documents. Copies of these documents will be placed in the employee's official personnel file." }
    ]
  },
  {
    id: "separation-of-employment",
    title: "Separation of Employment",
    blocks: [
      { h: "Termination" },
      { p: "P&M Apparel operates under the principle of at-will employment. This means that neither the employee nor P&M Apparel has entered into a contract regarding the duration of employment. The employee is free to terminate employment with P&M Apparel at any time, with or without reason. Likewise, P&M Apparel has the right to terminate the employee's employment with or without reason. P&M Apparel hopes that employees will provide at least a two (2) week notice in the event of resignation." },
      { p: "Upon termination of employment for any reason, employees may be paid for their accrued but unused PTO, up to a maximum of 40 hours. PTO payout will be calculated based on the employee's current hourly wage or salary equivalent. This payout will be included in the employee's final paycheck, issued on the next regular payday following the date of termination." },
      { h: "Insurance Conversion Privileges" },
      { p: "According to the federal Consolidated Omnibus Budget Reconciliation Act (COBRA) of 1985, in the event of termination of employment with P&M Apparel or loss of eligibility to remain covered under our group health insurance program, employees and their eligible dependents may have the right to continued coverage under our group health insurance program for a limited period of time at their own expense. Upon resignation or termination, all company sponsored insurance coverage ends on the date of separation." },
      { h: "Return of Company Property" },
      { p: "Any P&M Apparel owned property issued to an employee, such as product samples, computer equipment, keys, equipment or company credit card must be returned to P&M Apparel at the time of resignation / termination. Employees will be responsible for any lost or damaged items. The value of any property issued and not returned may be deducted from the employee's final paycheck, and the employee may be required to sign a payroll deduction authorization form for this purpose." },
      { h: "Re-Hire Eligibility" },
      { p: "Employees who have resigned or terminated may be eligible for re-hire. Re-hires must re-apply and follow the standard recruitment process. Consideration will be made dependent upon reason for leaving the company and company needs." }
    ]
  },
  {
    id: "employment-disclaimers",
    title: "Employment Disclaimers",
    blocks: [
      { p: "We are an equal opportunity employer and all qualified applicants will receive consideration for employment without regard to race, color, religion, sex, sexual orientation, gender identity or expression, pregnancy, age, national origin, disability status, genetic information, protected veteran status, or any other characteristic protected by law." },
      { p: "Employment with P&M Apparel is at will. This means employment is for an indefinite period of time and it is subject to termination by an employee or P&M Apparel, with or without cause, with or without notice, and at any time." },
      { p: "The at-will employment status of an employee of P&M Apparel may be modified only in a written employment agreement with that employee which is signed by the ownership of P&M Apparel." }
    ]
  }
];
