import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// FIREBASE INITIALIZATION
const appId = 'tips-tracker-40710';
const firebaseConfig = {
    apiKey: "AIzaSyDoYOEY21cq63oqoW50eMfHcjyOwfiEMVA",
    authDomain: "tips-tracker-40710.firebaseapp.com",
    projectId: "tips-tracker-40710",
    storageBucket: "tips-tracker-40710.firebasestorage.app",
    messagingSenderId: "785955241640",
    appId: "1:785955241640:web:5348673ef90e13c3208c9d",
    measurementId: "G-HG381FZG0N"
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

const { createApp, ref, computed, watch, onMounted, nextTick } = window.Vue;

const createEmptyDailyData = (daysCount) => {
    return Array.from({ length: daysCount }, () => ({ pool: null, hours: {}, driverTips: {} }));
};

const ensureThirtyOneDays = (dataArray) => {
    let arr = Array.isArray(dataArray) ? [...dataArray] : [];
    arr = arr.map(day => ({
        pool: day?.pool || null,
        hours: day?.hours || {},
        driverTips: day?.driverTips || {}
    }));
    while (arr.length < 31) {
        arr.push({ pool: null, hours: {}, driverTips: {} });
    }
    return arr.slice(0, 31);
};

const app = createApp({
    setup() {
        const isDbConnected = ref(false); 
        let unsubscribeSite = null;
        let remoteStateHash = '';

        const activeSite = ref('Red Bluff');
        const numDays = ref(31); 
        const employees = ref([]); // Shared across all sites
        const dailyData = ref(createEmptyDailyData(31));
        const activeTab = ref('master'); 
        const masterDisplayMode = ref('tips'); 
        const multiYearDisplayMode = ref('tips');
        const archivedMonthDisplayMode = ref('tips');
        const selectedArchiveYear = ref(new Date().getFullYear().toString());
        const yearlyArchives = ref({});

        const showEmployeeModal = ref(false);
        const showPermissionsModal = ref(false);
        const showExtensionModal = ref(false);
        const showTimeoutModal = ref(false);
        const selectedArchivedMonthDetail = ref(null);
        
        const showPayrollModal = ref(false);
        const payrollStartDate = ref('');
        const payrollEndDate = ref('');

        const showImportModal = ref(false);
        const isDraggingExcel = ref(false);
        const isDraggingOCR = ref(false);
        const isProcessingOCR = ref(false);
        const ocrStatus = ref('');
        const ocrProgress = ref(0);
        const pastedRawText = ref('');

        const newEmp = ref({ first: '', last: '', tempId: '', isDriver: false, isManager: false, siteRB: true, siteRD: true });
        
        const isFullTimeId = (id) => {
            if (!id) return false;
            return /^\d{3,}$/.test(String(id).trim());
        };

        const formatFirstName = (emp) => {
            if (emp.tempId) {
                const idStr = String(emp.tempId).trim();
                if (isFullTimeId(idStr)) return emp.firstName + ' (' + idStr + ')';
                const prefix = activeSite.value === 'Redding' ? 'E11-T' : 'E12-T';
                return emp.firstName + ' (' + prefix + idStr + ')';
            }
            return emp.firstName;
        };

        const refreshIcons = () => {
            nextTick(() => {
                if (window.lucide) window.lucide.createIcons();
            });
        };
        
        const extensions = ref([]);
        
        const activeExtension = ref(null);
        const activeExtensionIframe = ref(null);
        const newExtension = ref({ name: '', html: '' });
        const isDraggingFile = ref(false);
        const editingExtension = ref(null);
        
        const currentPayPeriod = ref(new Date().toISOString().slice(0, 7));
        const formattedPayPeriod = computed(() => {
            if (!currentPayPeriod.value) return '';
            const [year, month] = currentPayPeriod.value.split('-');
            const date = new Date(year, month - 1);
            return date.toLocaleString('default', { month: 'long', year: 'numeric' });
        });

        const handlePeriodChange = (event) => {
            const newPeriod = currentPayPeriod.value;
            if (!newPeriod) return;

            const [newYear, newMonthStr] = newPeriod.split('-');
            const newMonthIdx = parseInt(newMonthStr, 10);

            if (yearlyArchives.value[newYear] && yearlyArchives.value[newYear][newMonthIdx]) {
                showAlert(`Data for ${formattedPayPeriod.value} has already been archived. To view or export it, please open the 'Multi-Year Ledger' tab.\n\nThe main workspace is intended only for your current, active pay period.`);
            } 
            else {
                showConfirm(`You changed the active date to ${formattedPayPeriod.value}.\n\nWould you like to clear the workspace (reset all hours and tips) to start a fresh month?\n\n(Click Cancel if you are just fixing a typo in the date, or if you still need to hit the 'Archive Month' button!)`, () => {
                    dailyData.value = createEmptyDailyData(numDays.value);
                    logAction("Started New Month", `Cleared workspace to begin ${formattedPayPeriod.value}.`);
                    saveState();
                });
            }
            
            logAction('Changed Pay Period', 'Set period label to ' + formattedPayPeriod.value);
        };

        const ROLE_TIERS = {
            'DEV': 50,
            'ADMIN': 40,
            'MANAGER': 30,
            'SUPERVISOR': 20,
            'TEAM SHIFT LEAD': 10
        };

        const newUserAuth = ref({ name: '', pin: '', accessRB: true, accessRD: false, role: 'TEAM SHIFT LEAD' });
        const editingPin = ref(null);

        const currentUserData = ref(null);
        const loggedInUser = computed(() => currentUserData.value ? currentUserData.value.name : null);
        const currentUserAccess = computed(() => currentUserData.value ? currentUserData.value.access : []);
        const isManagerUnlocked = computed(() => currentUserData.value !== null);
        
        const currentUserRoleLevel = computed(() => {
            if (!currentUserData.value) return 0;
            return ROLE_TIERS[currentUserData.value.role] || 0;
        });

        const isDevUser = computed(() => currentUserRoleLevel.value === ROLE_TIERS['DEV']);
        const hasPermissionAccess = computed(() => currentUserRoleLevel.value >= ROLE_TIERS['MANAGER']); 
        const hasRoleAccess = computed(() => currentUserRoleLevel.value >= ROLE_TIERS['ADMIN']);

        const availableRolesToAssign = computed(() => {
            return Object.entries(ROLE_TIERS)
                .filter(([r, lvl]) => lvl < currentUserRoleLevel.value)
                .sort((a, b) => b[1] - a[1]) 
                .map(([r, lvl]) => r);
        });

        const getRoleBadgeClass = (role) => {
            switch(role) {
                case 'DEV': return 'bg-purple-100 text-purple-700 border border-purple-200';
                case 'ADMIN': return 'bg-red-100 text-red-700 border border-red-200';
                case 'MANAGER': return 'bg-amber-100 text-amber-700 border border-amber-200';
                case 'SUPERVISOR': return 'bg-blue-100 text-blue-700 border border-blue-200';
                case 'TEAM SHIFT LEAD': return 'bg-gray-100 text-gray-700 border border-gray-200';
                default: return 'bg-gray-100 text-gray-700 border border-gray-200';
            }
        };

        const pinInput = ref('');
        const setup2FA = ref({ isOpen: false, pin1: '', pin2: '' });
        const pending2FAUserPin = ref('');
        
        const defaultSystemUsers = {
            '4095': { name: 'Lenay A.', access: ['Red Bluff', 'Redding'], role: 'MANAGER', personalPin: null },
            '7444': { name: 'Tricia Kaplanis', access: ['Red Bluff', 'Redding'], role: 'ADMIN', personalPin: null },
            '2437': { name: 'Whitney M.', access: ['Red Bluff', 'Redding'], role: 'ADMIN', personalPin: null },
            '6032': { name: 'Kayley C.', access: ['Red Bluff', 'Redding'], role: 'ADMIN', personalPin: null },
            '7470': { name: 'Jordyn S.', access: ['Red Bluff'], role: 'TEAM SHIFT LEAD', personalPin: null },
            '6467': { name: 'William W.', access: ['Redding'], role: 'TEAM SHIFT LEAD', personalPin: null },
            '0500': { name: 'Nicholas G.', access: ['Red Bluff', 'Redding'], role: 'DEV', personalPin: null }
        };
        
        const systemUsers = ref(defaultSystemUsers);
        const sessionTimer = ref(null);
        const timeRemaining = ref(300);

        let isDragging = false;
        let startX = 0;
        let scrollLeft = 0;

        const auditLogs = ref([]);
        const modal = ref({ isOpen: false, type: 'alert', message: '', onConfirm: null });

        const history = ref([]);
        const historyIndex = ref(-1);
        let isUndoing = false;
        let isSwitchingSites = false;

        const availableArchiveYears = computed(() => {
            const yearsSet = new Set(Object.keys(yearlyArchives.value));
            if (currentPayPeriod.value) {
                yearsSet.add(currentPayPeriod.value.split('-')[0]);
            }
            if (yearsSet.size === 0) {
                yearsSet.add(new Date().getFullYear().toString());
            }
            return Array.from(yearsSet).sort();
        });

        const getMonthName = (mIdx) => {
            const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            return monthNames[mIdx - 1] || '';
        };

        const addNewYearTab = () => {
            const lastYear = availableArchiveYears.value[availableArchiveYears.value.length - 1] || new Date().getFullYear().toString();
            const nextYear = (parseInt(lastYear) + 1).toString();
            if (!yearlyArchives.value[nextYear]) {
                yearlyArchives.value[nextYear] = {};
            }
            selectedArchiveYear.value = nextYear;
            logAction("Added Year Tab", `Created year ${nextYear} in Multi-Year Ledger`);
        };

        const scrollToMonth = (mIdx) => {
            const el = document.getElementById(`month-section-${mIdx}`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };

        const isCurrentPayPeriodMonth = (mIdx) => {
            if (!currentPayPeriod.value) return false;
            const [year, monthStr] = currentPayPeriod.value.split('-');
            return year === selectedArchiveYear.value && parseInt(monthStr, 10) === mIdx;
        };

        const activeYearDisplayData = computed(() => {
            const year = selectedArchiveYear.value;
            const dataMap = {};
            
            const liveHours = {};
            employees.value.forEach(emp => {
                let h = 0;
                dailyData.value.forEach(day => {
                    h += parseFloat(day?.hours?.[emp.id]) || 0;
                });
                liveHours[emp.id] = h;
            });

            for (let m = 1; m <= 12; m++) {
                if (yearlyArchives.value[year]?.[m]) {
                    dataMap[m] = yearlyArchives.value[year][m];
                } else {
                    let isLiveMonth = false;
                    if (currentPayPeriod.value) {
                        const [currYr, currMStr] = currentPayPeriod.value.split('-');
                        if (currYr === year && parseInt(currMStr, 10) === m) {
                            isLiveMonth = true;
                        }
                    }

                    if (isLiveMonth) {
                        dataMap[m] = {
                            pool: masterTotalTips.value,
                            totalDistributed: masterTotalDistributed.value,
                            variance: masterTotalVariance.value,
                            payouts: monthlyStats.value.finalPayouts,
                            hours: liveHours,
                            dailyData: dailyData.value,
                            calculatedTips: calculatedTips.value,
                            isLive: true
                        };
                    } else {
                        dataMap[m] = {
                            pool: 0,
                            totalDistributed: 0,
                            variance: 0,
                            payouts: {},
                            hours: {},
                            dailyData: [],
                            calculatedTips: []
                        };
                    }
                }
            }
            return dataMap;
        });

        const activeYearSummary = computed(() => {
            let totalPool = 0;
            let totalDistributed = 0;
            let totalVariance = 0;
            let archivedCount = 0;
            const year = selectedArchiveYear.value;

            for (let m = 1; m <= 12; m++) {
                const mData = activeYearDisplayData.value[m];
                if (yearlyArchives.value[year]?.[m]) {
                    archivedCount++;
                }
                totalPool += parseFloat(mData.pool) || 0;
                totalDistributed += parseFloat(mData.totalDistributed) || 0;
                totalVariance += parseFloat(mData.variance) || 0;
            }
            return { totalPool, totalDistributed, totalVariance, archivedCount };
        });

        const activeYearEmployeeYTD = computed(() => {
            const totals = {};
            employees.value.forEach(emp => {
                let tips = 0;
                let hours = 0;
                for (let m = 1; m <= 12; m++) {
                    const mData = activeYearDisplayData.value[m];
                    tips += mData.payouts?.[emp.id] || 0;
                    hours += mData.hours?.[emp.id] || 0;
                }
                totals[emp.id] = { tips, hours };
            });
            return totals;
        });

        const getMonthDisplayData = (year, mIdx) => {
            if (yearlyArchives.value[year]?.[mIdx]) {
                return yearlyArchives.value[year][mIdx];
            }
            if (currentPayPeriod.value) {
                const [currYr, currMStr] = currentPayPeriod.value.split('-');
                if (currYr === year && parseInt(currMStr, 10) === mIdx) {
                    const livePayouts = monthlyStats.value.finalPayouts;
                    const liveHours = {};
                    employees.value.forEach(emp => {
                        let h = 0;
                        dailyData.value.forEach(day => {
                            h += parseFloat(day?.hours?.[emp.id]) || 0;
                        });
                        liveHours[emp.id] = h;
                    });
                    return {
                        pool: masterTotalTips.value,
                        totalDistributed: masterTotalDistributed.value,
                        variance: masterTotalVariance.value,
                        payouts: livePayouts,
                        hours: liveHours,
                        dailyData: dailyData.value,
                        calculatedTips: calculatedTips.value,
                        isLive: true
                    };
                }
            }
            return { pool: 0, totalDistributed: 0, variance: 0, payouts: {}, hours: {}, dailyData: [], calculatedTips: [] };
        };

        const getYearlySummary = (year) => {
            let totalPool = 0;
            let totalDistributed = 0;
            let totalVariance = 0;
            let archivedCount = 0;

            for (let m = 1; m <= 12; m++) {
                if (yearlyArchives.value[year]?.[m]) {
                    archivedCount++;
                    totalPool += parseFloat(yearlyArchives.value[year][m].pool) || 0;
                    totalDistributed += parseFloat(yearlyArchives.value[year][m].totalDistributed) || 0;
                    totalVariance += parseFloat(yearlyArchives.value[year][m].variance) || 0;
                } else if (currentPayPeriod.value) {
                    const [currYr, currMStr] = currentPayPeriod.value.split('-');
                    if (currYr === year && parseInt(currMStr, 10) === m) {
                        totalPool += masterTotalTips.value;
                        totalDistributed += masterTotalDistributed.value;
                        totalVariance += masterTotalVariance.value;
                    }
                }
            }
            return { totalPool, totalDistributed, totalVariance, archivedCount };
        };

        const getEmployeeYTDTotal = (year, empId) => {
            let tips = 0;
            let hours = 0;
            for (let m = 1; m <= 12; m++) {
                const mData = getMonthDisplayData(year, m);
                tips += mData.payouts?.[empId] || 0;
                hours += mData.hours?.[empId] || 0;
            }
            return { tips, hours };
        };

        // --- SITE SWITCHING WITH STATE PRESERVATION ---
        const switchSite = async (site) => {
            if (activeSite.value === site) return;
            
            // 1. Immediately save current site data before switching
            isSwitchingSites = true;
            await saveState();
            
            // 2. Set new active site & reset tab to master
            activeSite.value = site;
            activeTab.value = 'master';
            localStorage.setItem('sundial-last-site', activeSite.value);
            logAction("Switched Site", `Switched location view to ${site}`);
            
            // 3. Load the target site's independent workspace
            loadSiteData();
        };

        const archiveCurrentMonth = () => {
            if (!currentPayPeriod.value) return showAlert("Please select a pay period first.");
            const [year, monthStr] = currentPayPeriod.value.split('-');
            const monthIdx = parseInt(monthStr, 10);

            showConfirm(`Archive ${formattedPayPeriod.value} data (including full 31-day breakdown) into the Multi-Year Master Ledger?`, () => {
                if (!yearlyArchives.value[year]) {
                    yearlyArchives.value[year] = {};
                }

                const monthPayouts = {};
                const monthHours = {};

                employees.value.forEach(emp => {
                    monthPayouts[emp.id] = monthlyStats.value.finalPayouts[emp.id] || 0;
                    let totalH = 0;
                    dailyData.value.forEach(day => {
                        totalH += parseFloat(day?.hours?.[emp.id]) || 0;
                    });
                    monthHours[emp.id] = totalH;
                });

                yearlyArchives.value[year][monthIdx] = {
                    pool: masterTotalTips.value,
                    totalDistributed: masterTotalDistributed.value,
                    variance: masterTotalVariance.value,
                    payouts: monthPayouts,
                    hours: monthHours,
                    dailyData: JSON.parse(JSON.stringify(dailyData.value)),
                    calculatedTips: JSON.parse(JSON.stringify(calculatedTips.value)),
                    archivedAt: new Date().toISOString()
                };

                logAction('Archived Month', `Archived ${formattedPayPeriod.value} with complete daily records into Multi-Year Master Ledger.`);
                saveState();
                activeTab.value = 'multiyear';
                selectedArchiveYear.value = year;
                showAlert(`${formattedPayPeriod.value} has been archived with full 31-day daily tracking!`);
            });
        };

        const closeArchivedMonthDetail = () => {
            selectedArchivedMonthDetail.value = null;
        };

        const showAlert = (msg) => { modal.value = { isOpen: true, type: 'alert', message: msg, onConfirm: null }; nextTick(() => lucide.createIcons()); };
        const showConfirm = (msg, callback) => { modal.value = { isOpen: true, type: 'confirm', message: msg, onConfirm: callback }; nextTick(() => lucide.createIcons()); };
        const closeModal = () => { modal.value.isOpen = false; };
        const confirmModal = () => { if (modal.value.onConfirm) modal.value.onConfirm(); closeModal(); };

        const logAction = (action, details) => {
            if (!loggedInUser.value) return; 
            const now = new Date();
            const timeString = now.toLocaleDateString() + ' ' + now.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            auditLogs.value.unshift({
                id: Date.now() + Math.random().toString(36).substring(2, 7),
                timestamp: timeString,
                user: loggedInUser.value,
                action: action,
                details: details
            });
            saveState();
        };

        const clearAuditLog = () => {
            showConfirm("Are you sure you want to delete the entire audit log? This cannot be undone.", () => {
                auditLogs.value = [];
                logAction("Cleared Audit Log", "User manually wiped the audit history.");
                saveState();
            });
        };

        const exportAuditLog = () => {
            try {
                const wb = XLSX.utils.book_new();
                const logData = [['Date / Time', 'User', 'Action', 'Details']];
                auditLogs.value.forEach(log => {
                    logData.push([log.timestamp, log.user, log.action, log.details]);
                });
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(logData), 'Audit Log');
                XLSX.writeFile(wb, `Sundial_${activeSite.value.replace(/\s+/g, '_')}_AuditLog.xlsx`);
                logAction("Exported Audit Log", "User exported system audit log.");
            } catch (error) { 
                console.error(error);
                showAlert('Error generating Excel file. Please try again.'); 
            }
        };

        const resetPersonalPin = (pin) => {
            showConfirm(`Are you sure you want to reset the 2FA personal PIN for ${systemUsers.value[pin].name}? They will be prompted to create a new one on their next login.`, () => {
                systemUsers.value[pin].personalPin = null;
                logAction("2FA Reset", `Admin reset the personal PIN for user ${systemUsers.value[pin].name}.`);
            });
        };

        const editSystemUser = (pin) => {
            const user = systemUsers.value[pin];
            if (ROLE_TIERS[user.role] >= currentUserRoleLevel.value) {
                return showAlert("Unauthorized. You cannot edit a user with equal or higher clearance.");
            }
            newUserAuth.value = {
                name: user.name,
                pin: pin,
                accessRB: user.access.includes('Red Bluff'),
                accessRD: user.access.includes('Redding'),
                role: user.role
            };
            editingPin.value = pin;
        };

        const cancelEdit = () => {
            const defaultRole = availableRolesToAssign.value.length > 0 ? availableRolesToAssign.value[availableRolesToAssign.value.length - 1] : 'TEAM SHIFT LEAD';
            newUserAuth.value = { name: '', pin: '', accessRB: true, accessRD: false, role: defaultRole };
            editingPin.value = null;
        };

        const saveSystemUser = () => {
            const newPin = newUserAuth.value.pin.trim();
            const name = newUserAuth.value.name.trim();
            const targetRole = newUserAuth.value.role;

            if (newPin.length !== 4 || isNaN(newPin)) return showAlert("PIN must be exactly 4 digits.");
            if (!name) return showAlert("Please enter a name for the user.");
            
            if (ROLE_TIERS[targetRole] >= currentUserRoleLevel.value) {
                return showAlert("Unauthorized. You cannot assign a role equal to or higher than your own clearance.");
            }
            
            if (editingPin.value) {
                const existingTargetUser = systemUsers.value[editingPin.value];
                if (ROLE_TIERS[existingTargetUser.role] >= currentUserRoleLevel.value) {
                    return showAlert("Unauthorized. You cannot edit a user with equal or higher clearance.");
                }
                if (newPin !== editingPin.value && systemUsers.value[newPin]) {
                    return showAlert("This new PIN is already in use by another account.");
                }
            } else {
                if (systemUsers.value[newPin]) return showAlert("This PIN is already in use by another account.");
            }
            
            const access = [];
            if (newUserAuth.value.accessRB) access.push('Red Bluff');
            if (newUserAuth.value.accessRD) access.push('Redding');
            
            if (access.length === 0) return showAlert("User must have access to at least one site.");

            const userData = {
                name: name,
                access: access,
                role: targetRole,
                personalPin: editingPin.value ? systemUsers.value[editingPin.value].personalPin : null
            };

            if (editingPin.value) {
                if (newPin !== editingPin.value) {
                    delete systemUsers.value[editingPin.value];
                }
                systemUsers.value[newPin] = userData;
                logAction("User Edited", `Updated system access for ${name} (PIN: ${newPin}).`);
                
                if (editingPin.value === currentUserData.value?.pin) {
                    if (newPin !== currentUserData.value.pin) {
                        forceLock("Session locked. You modified your own PIN and must sign back in.");
                        cancelEdit();
                        return;
                    } else {
                        currentUserData.value = { ...userData, pin: newPin };
                    }
                }
            } else {
                systemUsers.value[newPin] = userData;
                logAction("User Added", `Created system access for ${name}.`);
            }
            
            cancelEdit();
        };

        const removeSystemUser = (pin, name) => {
            const targetUser = systemUsers.value[pin];
            if (ROLE_TIERS[targetUser.role] >= currentUserRoleLevel.value) {
                return showAlert("Unauthorized. You cannot remove a user with equal or higher clearance.");
            }
            showConfirm(`Are you sure you want to revoke system access for ${name}?`, () => {
                delete systemUsers.value[pin];
                logAction("User Revoked", `Removed system access for ${name}.`);
            });
        };

        // --- WATCHERS FOR GLOBAL SETTINGS & SHARED ROSTER ---
        watch(systemUsers, async () => {
            if (!isDbConnected.value || !auth.currentUser) return;
            try { await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_globals', 'settings'), { systemUsers: systemUsers.value, extensions: extensions.value, employees: employees.value }, { merge: true }); } catch (e) { console.error(e); }
        }, { deep: true });

        watch(extensions, async () => {
            if (!isDbConnected.value || !auth.currentUser) return;
            try { await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_globals', 'settings'), { systemUsers: systemUsers.value, extensions: extensions.value, employees: employees.value }, { merge: true }); } catch (e) { console.error(e); }
        }, { deep: true });

        // Synchronize shared employee roster globally
        watch(employees, async () => {
            if (!isDbConnected.value || !auth.currentUser) return;
            try { await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_globals', 'settings'), { systemUsers: systemUsers.value, extensions: extensions.value, employees: employees.value }, { merge: true }); } catch (e) { console.error(e); }
        }, { deep: true });

        const launchExtension = (ext) => {
            activeExtension.value = ext;
            showExtensionModal.value = false;
            nextTick(() => lucide.createIcons());
        };

        const closeExtension = () => {
            activeExtension.value = null;
            nextTick(() => lucide.createIcons());
        };

        const addExtension = () => {
            if (!newExtension.value.name.trim() || !newExtension.value.html.trim()) {
                return showAlert("Please provide both a Tool Name and the HTML code to install it.");
            }
            extensions.value.push({
                id: 'ext_' + Date.now() + Math.random().toString(36).substr(2, 5),
                name: newExtension.value.name.trim(),
                html: newExtension.value.html.trim()
            });
            logAction("Installed Virtual Tool", `Installed new app extension: ${newExtension.value.name}`);
            newExtension.value = { name: '', html: '' };
        };

        const removeExtension = (id) => {
            showConfirm("Are you sure you want to permanently delete this installed tool?", () => {
                extensions.value = extensions.value.filter(e => e.id !== id);
                logAction("Removed Virtual Tool", "Deleted an app extension from the App Hub.");
            });
        };

        const handleFileDrop = (event) => {
            isDraggingFile.value = false;
            const file = event.dataTransfer?.files?.[0];
            if (!file) return;

            if (!file.name.toLowerCase().endsWith('.html') && !file.name.toLowerCase().endsWith('.htm') && !file.name.toLowerCase().endsWith('.txt')) {
                return showAlert("Please drop a valid HTML file.");
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const content = e.target.result;
                let fileName = file.name.replace(/\.[^/.]+$/, ""); 
                fileName = fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()); 
                
                newExtension.value.name = fileName;
                newExtension.value.html = content;
            };
            reader.readAsText(file);
        };

        const editExtension = (ext) => {
            editingExtension.value = { ...ext };
            nextTick(() => lucide.createIcons());
        };
        
        const updateExtension = () => {
            if (!editingExtension.value.name.trim() || !editingExtension.value.html.trim()) return showAlert("Tool name and HTML code cannot be empty.");
            const index = extensions.value.findIndex(e => e.id === editingExtension.value.id);
            if (index !== -1) {
                extensions.value[index].name = editingExtension.value.name.trim();
                extensions.value[index].html = editingExtension.value.html.trim();
                logAction("Updated Virtual Tool", `Injected new code updates into: ${extensions.value[index].name}`);
                editingExtension.value = null;
                nextTick(() => lucide.createIcons());
            }
        };

        const cancelEditExtension = () => {
            editingExtension.value = null;
            nextTick(() => lucide.createIcons());
        };

        const syncDataToExtension = () => {
            if (activeExtensionIframe.value && activeExtensionIframe.value.contentWindow) {
                const cleanEmployees = JSON.parse(JSON.stringify(employees.value));
                const cleanDailyData = JSON.parse(JSON.stringify(dailyData.value));
                
                const payload = {
                    type: 'SUNDIAL_DATA_SYNC',
                    site: activeSite.value,
                    period: formattedPayPeriod.value,
                    employees: cleanEmployees,
                    data: cleanDailyData,
                    calculatedTips: JSON.parse(JSON.stringify(calculatedTips.value)),
                    masterTotalTips: masterTotalTips.value,
                    masterTotalDistributed: masterTotalDistributed.value,
                    masterTotalVariance: masterTotalVariance.value,
                    monthlyPayouts: JSON.parse(JSON.stringify(monthlyStats.value.finalPayouts)),
                    yearlyArchives: JSON.parse(JSON.stringify(yearlyArchives.value))
                };
                
                activeExtensionIframe.value.contentWindow.postMessage(payload, '*');
                logAction("API Sync", `Pushed live data payload to Virtual Tool: ${activeExtension.value.name}`);
                
                const btn = document.querySelector('button[title="Push live data to this tool"]');
                if (btn) {
                    const originalHTML = btn.innerHTML;
                    btn.innerHTML = '<i data-lucide="check-circle" class="w-4 h-4"></i> Data Sent!';
                    btn.classList.add('bg-green-500');
                    btn.classList.remove('bg-blue-500');
                    nextTick(() => lucide.createIcons());
                    setTimeout(() => {
                        btn.innerHTML = originalHTML;
                        btn.classList.remove('bg-green-500');
                        btn.classList.add('bg-blue-500');
                        nextTick(() => lucide.createIcons());
                    }, 2000);
                }
            }
        };

        const formattedTimeRemaining = computed(() => {
            const m = Math.floor(timeRemaining.value / 60);
            const s = timeRemaining.value % 60;
            return `${m}:${s.toString().padStart(2, '0')}`;
        });

        const forceLock = (reason = "Manager manually locked the app.") => {
            clearInterval(sessionTimer.value);
            showTimeoutModal.value = false;
            showPermissionsModal.value = false;
            showEmployeeModal.value = false;
            showExtensionModal.value = false;
            showImportModal.value = false;
            setup2FA.value.isOpen = false;
            activeExtension.value = null;
            selectedArchivedMonthDetail.value = null;
            if (loggedInUser.value) {
                logAction('System Locked', reason);
                currentUserData.value = null; 
            }
            nextTick(() => lucide.createIcons());
        };

        const startSessionTimer = () => {
            clearInterval(sessionTimer.value);
            timeRemaining.value = 300; 
            showTimeoutModal.value = false;
            sessionTimer.value = setInterval(() => {
                timeRemaining.value--;
                if (timeRemaining.value === 90) {
                    showTimeoutModal.value = true;
                    nextTick(() => lucide.createIcons());
                }
                if (timeRemaining.value <= 0) {
                    forceLock("Session time expired (5 minutes limit reached).");
                }
            }, 1000);
        };

        const resetTimerActivity = () => {
            if (isManagerUnlocked.value && timeRemaining.value > 0) {
                if (timeRemaining.value < 300) timeRemaining.value = 300;
                if (showTimeoutModal.value) showTimeoutModal.value = false;
            }
        };

        const extendSession = () => {
            timeRemaining.value = 300;
            showTimeoutModal.value = false;
            logAction("Session Extended", "Manager added 5 more minutes to the session.");
        };

        const startDrag = (e) => {
            if (['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
            isDragging = true;
            startX = e.pageX - e.currentTarget.offsetLeft;
            scrollLeft = e.currentTarget.scrollLeft;
            e.currentTarget.style.userSelect = 'none'; 
        };

        const onDrag = (e) => {
            if (!isDragging) return;
            e.preventDefault(); 
            const x = e.pageX - e.currentTarget.offsetLeft;
            const walk = (x - startX) * 1.5; 
            e.currentTarget.scrollLeft = scrollLeft - walk;
        };

        const stopDrag = (e) => {
            isDragging = false;
            e.currentTarget.style.userSelect = ''; 
        };

        const processWorkbook = (wb, isPastedSingleSheet = false) => {
            const parsedEmployees = new Map();
            employees.value.forEach(e => {
                const key = `${e.lastName.toLowerCase().trim()}_${e.firstName.toLowerCase().trim()}`;
                parsedEmployees.set(key, JSON.parse(JSON.stringify(e)));
            });

            const newDailyData = JSON.parse(JSON.stringify(dailyData.value));

            const getEmp = (ln, fn) => {
                if(!ln) return null;
                
                let origFn = String(fn||'').trim();
                let cleanFn = origFn.toLowerCase();
                let extractedTemp = '';
                const tempMatch = origFn.match(/\(T-(.*?)\)/i);
                if (tempMatch) {
                    extractedTemp = tempMatch[1].trim();
                    origFn = origFn.replace(/\s*\(T-.*?\)/i, '').trim();
                    cleanFn = origFn.toLowerCase();
                }

                const key = `${String(ln).toLowerCase().trim()}_${cleanFn}`;
                if(!parsedEmployees.has(key)) {
                    const existing = employees.value.find(e => e.lastName.toLowerCase() === String(ln).toLowerCase().trim() && e.firstName.toLowerCase() === cleanFn);
                    parsedEmployees.set(key, { 
                        id: existing ? existing.id : 'emp_' + Date.now() + Math.random().toString(36).substr(2, 9), 
                        lastName: String(ln).trim(), 
                        firstName: origFn, 
                        isDriver: existing ? existing.isDriver : false,
                        isManager: existing ? existing.isManager : false,
                        tempId: extractedTemp || (existing ? (existing.tempId || '') : '')
                    });
                }
                return parsedEmployees.get(key);
            };

            const parseNumber = (val) => {
                if (val === null || val === undefined || val === '') return 0;
                if (typeof val === 'number') return val;
                const cleaned = String(val).replace(/[^0-9.-]+/g,"");
                const num = parseFloat(cleaned);
                return isNaN(num) ? 0 : num;
            };

            const firstSheet = wb.Sheets[wb.SheetNames[0]];
            const txtTest = XLSX.utils.sheet_to_csv(firstSheet).toLowerCase();
            
            if (txtTest.includes('detailed daily breakdown') || (txtTest.includes('--- tip distribution') && txtTest.includes('day 1') && txtTest.includes('day 2'))) {
                const rows = XLSX.utils.sheet_to_json(firstSheet, {header: 1, defval: null});
                let mode = null; 
                let dayCols = {}; 
                
                for (let r = 0; r < rows.length; r++) {
                    const row = rows[r]; if (!row) continue;
                    const col0 = String(row[0] || '').toLowerCase().trim();
                    
                    if (col0.includes('--- tip distribution')) { mode = 'tips'; continue; }
                    if (col0.includes('--- hours worked')) { mode = 'hours'; continue; }
                    if (col0.includes('--- driver direct tips')) { mode = 'drivers'; continue; }
                    
                    if (col0.includes('last name') || col0 === 'last') {
                        dayCols = {};
                        for (let c = 2; c < row.length; c++) {
                            const cellStr = String(row[c] || '').toLowerCase().trim();
                            if (cellStr.startsWith('day ')) {
                                const dayNum = parseInt(cellStr.replace('day ', ''));
                                if (!isNaN(dayNum) && dayNum >= 1 && dayNum <= 31) {
                                    dayCols[c] = dayNum - 1;
                                }
                            }
                        }
                        continue;
                    }
                    
                    if (mode === 'tips' && col0.includes('daily tip pool')) {
                        for (const c in dayCols) {
                            if (row[c] !== null && row[c] !== '') newDailyData[dayCols[c]].pool = parseNumber(row[c]);
                        }
                        continue;
                    }
                    
                    if (col0.includes('daily variance') || col0.includes('rounding')) continue;
                    
                    if (col0 && col0 !== '') {
                        const ln = row[0];
                        const fn = row[1];
                        if (!ln) continue;
                        
                        const emp = getEmp(ln, fn);
                        if (emp) {
                            if (mode === 'hours') {
                                for (const c in dayCols) {
                                    if (row[c] !== null && row[c] !== '') newDailyData[dayCols[c]].hours[emp.id] = parseNumber(row[c]);
                                }
                            } else if (mode === 'drivers') {
                                emp.isDriver = true;
                                for (const c in dayCols) {
                                    if (row[c] !== null && row[c] !== '') newDailyData[dayCols[c]].driverTips[emp.id] = parseNumber(row[c]);
                                }
                            }
                        }
                    }
                }
                
                employees.value = Array.from(parsedEmployees.values());
                dailyData.value = newDailyData;
                numDays.value = 31;
                activeTab.value = 'master';
                logAction("System Override: Raw Data Inject", `Injected Horizontal Multi-Day Breakdown data.`);
                saveState();
                showImportModal.value = false;
                pastedRawText.value = '';
                return showAlert("Success! Parsed Multi-Day Breakdown and populated all 31 days.");
            }

            let masterSheetName = wb.SheetNames.find(n => n.toLowerCase().includes('master'));
            let dailySheetNames = wb.SheetNames.filter(n => n.replace(/[^0-9]/g, '').length > 0).sort((a,b) => parseInt(a.replace(/[^0-9]/g, '')) - parseInt(b.replace(/[^0-9]/g, '')));

            if (isPastedSingleSheet && wb.SheetNames.length === 1 && !masterSheetName && dailySheetNames.length === 0) {
                const ws = wb.Sheets[wb.SheetNames[0]];
                const txt = XLSX.utils.sheet_to_csv(ws).toLowerCase();
                if (txt.includes('total tip pool') || txt.includes('final total')) {
                    masterSheetName = wb.SheetNames[0];
                } else {
                    dailySheetNames = [wb.SheetNames[0]];
                }
            }

            if (masterSheetName) {
                const mWs = wb.Sheets[masterSheetName];
                const mRows = XLSX.utils.sheet_to_json(mWs, {header: 1, defval: null});
                let mInRoster = false;
                let mLnCol = -1, mFnCol = -1;
                
                for(let r=0; r<mRows.length; r++) {
                    const row = mRows[r]; if(!row) continue;
                    if(!mInRoster) {
                        for(let c=0; c<row.length; c++) {
                            const str = String(row[c] || '').toLowerCase().trim();
                            if(str === 'last name' || str === 'last') mLnCol = c;
                            if(str === 'first name' || str === 'first') mFnCol = c;
                        }
                        if(mLnCol !== -1 && mFnCol !== -1) { mInRoster = true; continue; }
                    }
                    if(mInRoster) {
                        const ln = row[mLnCol];
                        const fn = row[mFnCol];
                        const str = String(ln || '').toLowerCase().trim();
                        if(!ln || str === '' || str.includes('overage') || str.includes('variance') || str.includes('total')) {
                            mInRoster = false;
                        } else {
                            getEmp(ln, fn); 
                        }
                    }
                }
            }

            dailySheetNames.forEach((sheetName) => {
                let index = 0;
                if (isPastedSingleSheet) {
                    index = typeof activeTab.value === 'number' ? activeTab.value : 0;
                } else {
                    const match = sheetName.match(/\d+/);
                    if (!match) return;
                    const dayNum = parseInt(match[0]);
                    if (dayNum < 1 || dayNum > 31) return;
                    index = dayNum - 1; 
                }
                
                const ws = wb.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(ws, {header: 1, defval: null});
                let poolParsed = false, inRoster = false, inDrivers = false;
                let lastNameCol = -1, firstNameCol = -1, hoursCol = -1, driverNameCol = -1, driverTipCol = -1;

                for (let r = 0; r < rows.length; r++) {
                    const row = rows[r]; if (!row) continue;
                    
                    if (!poolParsed) {
                        for (let c = 0; c < row.length; c++) {
                            const cellStr = String(row[c] || '').toLowerCase().trim();
                            if (cellStr.includes('total amount') || cellStr.includes('tip pool') || cellStr.includes('pool')) {
                                let val = parseNumber(row[c+1]);
                                if(val === 0 && row.length > c+2) val = parseNumber(row[c+2]);
                                if(val === 0 && rows[r+1]) val = parseNumber(rows[r+1][c]); 
                                if(val === 0 && rows[r+1] && rows[r+1].length > c+1) val = parseNumber(rows[r+1][c+1]);
                                newDailyData[index].pool = val; 
                                poolParsed = true; 
                                break; 
                            }
                        }
                    }

                    if (!inRoster && !inDrivers) {
                        for (let c = 0; c < row.length; c++) {
                            const cellStr = String(row[c] || '').toLowerCase().trim();
                            if (cellStr.includes('last name') || cellStr === 'last') lastNameCol = c;
                            if (cellStr.includes('first name') || cellStr === 'first') firstNameCol = c;
                            if (cellStr.includes('hours') || cellStr.includes('hrs')) hoursCol = c;
                        }
                        if (lastNameCol === -1 && String(row[0]||'').toLowerCase().includes('last')) lastNameCol = 0;
                        if (firstNameCol === -1 && String(row[1]||'').toLowerCase().includes('first')) firstNameCol = 1;
                        if (hoursCol === -1 && (String(row[2]||'').toLowerCase().includes('hour') || String(row[2]||'').toLowerCase().includes('hrs'))) hoursCol = 2;
                        if (lastNameCol !== -1 && firstNameCol !== -1 && hoursCol !== -1) { 
                            inRoster = true; 
                            continue; 
                        }
                    }

                    if (inRoster && !inDrivers) {
                        const ln = row[lastNameCol]; 
                        const fn = row[firstNameCol];
                        const cellStr = String(ln || '').toLowerCase().trim();
                        if (!ln || cellStr === '' || cellStr.includes('verification') || cellStr.includes('overage') || cellStr.includes('totals') || cellStr.includes('driver')) { 
                            inRoster = false; 
                        } else {
                            const emp = getEmp(ln, fn);
                            if (emp) newDailyData[index].hours[emp.id] = parseNumber(row[hoursCol]);
                        }
                    }

                    if (!inRoster && !inDrivers) {
                        for (let c = 0; c < row.length; c++) {
                            const cellStr = String(row[c] || '').toLowerCase().trim();
                            if (cellStr.includes('driver')) driverNameCol = c;
                            if (cellStr.includes('tip')) driverTipCol = c;
                        }
                        if (driverNameCol !== -1 && driverTipCol !== -1) { 
                            inDrivers = true; 
                            continue; 
                        }
                    }

                    if (inDrivers) {
                        const drvNameStr = row[driverNameCol];
                        const cellStr = String(drvNameStr || '').toLowerCase().trim();
                        if (!drvNameStr || cellStr === '' || cellStr.includes('total') || cellStr.includes('variance')) {
                        } else {
                            let ln = '', fn = '';
                            if (String(drvNameStr).includes(',')) {
                                const parts = String(drvNameStr).split(',');
                                ln = parts[0].trim(); fn = parts[1].trim();
                            } else { 
                                ln = String(drvNameStr).trim(); 
                            }
                            const emp = getEmp(ln, fn);
                            if (emp) { 
                                emp.isDriver = true; 
                                newDailyData[index].driverTips[emp.id] = parseNumber(row[driverTipCol]); 
                            }
                        }
                    }
                }
            });

            employees.value = Array.from(parsedEmployees.values());
            dailyData.value = newDailyData; 
            numDays.value = 31;
            activeTab.value = 'master';
            
            logAction("System Override: Raw Data Inject", `Bypassed UI locks. Successfully parsed and injected raw data.`);
            saveState(); 
            showImportModal.value = false;
            pastedRawText.value = '';
            
            let msg = isPastedSingleSheet ? `Success! Pasted data cleanly injected into Day ${typeof activeTab.value === 'number' ? activeTab.value + 1 : 1}.` : `Success! Excel data instantly injected into ${activeSite.value}.`;
            showAlert(msg);
        };

        const handleExcelDrop = (event) => {
            isDraggingExcel.value = false;
            const file = event.dataTransfer?.files?.[0];
            if (!file) return;
            
            if (!file.name.toLowerCase().endsWith('.xlsx') && !file.name.toLowerCase().endsWith('.xls') && !file.name.toLowerCase().endsWith('.csv')) {
                return showAlert("Please drop a valid Excel file (.xlsx, .xls, .csv).");
            }
            
            const mockEvent = { target: { files: [file] } };
            importExcel(mockEvent);
        };

        const handleOCRDrop = (event) => {
            isDraggingOCR.value = false;
            const file = event.dataTransfer?.files?.[0];
            if (!file) return;
            const mockEvent = { target: { files: [file] } };
            importOCR(mockEvent);
        };

        const importOCR = async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            if (app.refs && app.refs.ocrUpload) app.refs.ocrUpload.value = '';

            if (employees.value.length === 0) {
                return showAlert("Please add employees to your roster first so the scanner can match names.");
            }

            isProcessingOCR.value = true;
            ocrStatus.value = 'Preparing file...';

            try {
                let imageSrc = '';
                if (file.type === 'application/pdf') {
                    ocrStatus.value = 'Rendering PDF...';
                    if (window.pdfjsLib) {
                        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    }
                    const arrayBuffer = await file.arrayBuffer();
                    const pdf = await window.pdfjsLib.getDocument({data: arrayBuffer}).promise;
                    const page = await pdf.getPage(1);
                    const viewport = page.getViewport({scale: 2.5}); 
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    await page.render({canvasContext: context, viewport: viewport}).promise;
                    imageSrc = canvas.toDataURL('image/png');
                } else {
                    imageSrc = URL.createObjectURL(file);
                }

                ocrStatus.value = 'Initializing AI Scanner...';
                const worker = await Tesseract.createWorker({
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            ocrProgress.value = m.progress;
                            ocrStatus.value = `Scanning... ${Math.round(m.progress * 100)}%`;
                        }
                    }
                });

                await worker.loadLanguage('eng');
                await worker.initialize('eng');
                const { data: { text } } = await worker.recognize(imageSrc);
                await worker.terminate();

                autoFillFromOCR(text);

            } catch (err) {
                console.error(err);
                showAlert("OCR Scanning Failed: " + err.message);
            } finally {
                isProcessingOCR.value = false;
                ocrStatus.value = '';
            }
        };

        const autoFillFromOCR = (text) => {
            let poolAmount = '';
            const poolMatch = text.match(/(?:Amount|Total).*?(\d+\.\d{2})/i);
            if (poolMatch) poolAmount = poolMatch[1];

            let tsv = `Total Amount of Tips\t${poolAmount}\n\n`;
            tsv += `Last Name\tFirst Name\tHours Worked\n`;

            const lines = text.split('\n');
            lines.forEach(line => {
                let matchedEmp = null;
                for (const emp of employees.value) {
                    const regex = new RegExp(`\\b${emp.firstName}\\b`, 'i');
                    if (regex.test(line)) {
                        matchedEmp = emp;
                        break;
                    }
                }
                
                if (matchedEmp) {
                    const nums = line.match(/\d+\.\d{1,2}|\b\d+\b/g);
                    if (nums && nums.length >= 1) {
                        const hrs = nums[0];
                        tsv += `${matchedEmp.lastName}\t${matchedEmp.firstName}\t${hrs}\n`;
                    }
                }
            });

            pastedRawText.value = tsv;
            logAction("Performed OCR Scan", "Extracted data from an uploaded image/PDF into the injection hub.");
            nextTick(() => lucide.createIcons());
        };

        const handleGlobalPaste = (event) => {
            if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;

            const items = (event.clipboardData || event.originalEvent.clipboardData).items;
            for (let index in items) {
                const item = items[index];
                if (item.kind === 'file') {
                    const blob = item.getAsFile();
                    if (blob && (blob.name.endsWith('.xlsx') || blob.name.endsWith('.xls') || blob.type.includes('excel') || blob.type.includes('spreadsheet') || blob.name.endsWith('.csv'))) {
                        const mockEvent = { target: { files: [blob] } };
                        importExcel(mockEvent);
                        event.preventDefault();
                        return;
                    }
                }
            }
            
            const text = event.clipboardData.getData('text');
            if (text) {
                pastedRawText.value = text;
                processPastedText();
                event.preventDefault();
            }
        };

        const processPastedText = () => {
            const txt = pastedRawText.value.trim();
            if (!txt) return showAlert("Please paste some data or a JSON backup string into the box first.");
            
            try {
                const wb = XLSX.read(txt, {type: 'string'});
                processWorkbook(wb, true);
            } catch(e) {
                console.error(e);
                showAlert("Error parsing pasted text. Ensure you are pasting valid copied cells directly from Excel.");
            }
        };

        const importExcel = async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const wb = XLSX.read(data, {type: 'array'});
                    processWorkbook(wb, false);
                } catch (err) { 
                    console.error(err);
                    showAlert("Error parsing file. Please ensure it is a valid Excel format exported from this app."); 
                }
                finally { 
                    if(app.refs && app.refs.fileUpload) {
                        app.refs.fileUpload.value = ''; 
                    }
                }
            };
            reader.readAsArrayBuffer(file);
        };

        const finalizeLogin = (matchedUser, pin) => {
            currentUserData.value = { ...matchedUser, pin: pin };
            if (!matchedUser.access.includes(activeSite.value)) {
                switchSite(matchedUser.access[0]);
            }
            logAction('System Unlocked', 'Logged into manager session.');
            startSessionTimer();
        };

        const handleLogin = () => {
            let parsedPin = pinInput.value.trim();
            
            if (parsedPin.length === 8) {
                const basePin = parsedPin.substring(0, 4);
                const persPin = parsedPin.substring(4, 8);
                const matchedUser = systemUsers.value[basePin];
                
                if (matchedUser && matchedUser.personalPin === persPin) {
                    finalizeLogin(matchedUser, basePin);
                } else {
                    showAlert("Incorrect 8-digit PIN combination. Access Denied.");
                }
            } 
            else if (parsedPin.length === 4) {
                const matchedUser = systemUsers.value[parsedPin];
                if (matchedUser) {
                    if (matchedUser.personalPin) {
                        showAlert("2FA is enabled for this account. Please enter your full 8-digit PIN (Admin Assigned + Personal).");
                    } else {
                        pending2FAUserPin.value = parsedPin;
                        setup2FA.value.isOpen = true;
                        setup2FA.value.pin1 = '';
                        setup2FA.value.pin2 = '';
                    }
                } else {
                    showAlert("Incorrect PIN. Access Denied.");
                }
            } else {
                showAlert("Please enter a valid 4-digit or 8-digit PIN.");
            }
            pinInput.value = '';
            nextTick(() => lucide.createIcons());
        };

        const save2FASetup = () => {
            if (setup2FA.value.pin1.length !== 4 || isNaN(setup2FA.value.pin1)) {
                return showAlert("Personal PIN must be exactly 4 digits.");
            }
            if (setup2FA.value.pin1 !== setup2FA.value.pin2) {
                return showAlert("PINs do not match. Please try again.");
            }
            
            const basePin = pending2FAUserPin.value;
            systemUsers.value[basePin].personalPin = setup2FA.value.pin1;
            
            setup2FA.value.isOpen = false;
            logAction("2FA Setup", `User configured their 4-digit personal PIN for the first time.`);
            finalizeLogin(systemUsers.value[basePin], basePin);
        };

        const formatCurrency = (value, showSign = false) => {
            if (value === null || value === undefined || isNaN(value)) return '$ 0.00';
            const num = Math.abs(value);
            const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
            if (showSign && value < 0) return `$ (${num.toFixed(2)})`; 
            return formatted.replace('$', '$ ');
        };

        const formatCurrencyBlanks = (value, isVariance = false) => {
            if (!value || value === 0) return isVariance ? '$ -' : '$  -';
            return formatCurrency(value, isVariance);
        };

        const getHourInputClass = (hours) => {
            if (hours === undefined || hours === null || hours === '' || parseFloat(hours) === 0) return 'bg-white';
        const sortedEmployees = computed(() => {
            return employees.value
                .filter(emp => {
                    // Fallback for legacy records without explicit site array
                    if (!emp.sites || !Array.isArray(emp.sites) || emp.sites.length === 0) return true;
                    return emp.sites.includes(activeSite.value);
                })
                .sort((a, b) => a.lastName.localeCompare(b.lastName));
        });
        const driverEmployees = computed(() => sortedEmployees.value.filter(e => e.isDriver));

        const roundToQuarter = (num) => Math.round(num * 4) / 4;

        const calculatedTips = computed(() => {
            return dailyData.value.map(day => {
                const pool = parseFloat(day?.pool) || 0;
                let totalHours = 0;
                sortedEmployees.value.forEach(emp => {
                    if (!emp.isManager) totalHours += parseFloat(day?.hours?.[emp.id]) || 0;
                });
                const rate = totalHours > 0 ? pool / totalHours : 0;
                
                let totalDistributed = 0;
                const tips = {};
                sortedEmployees.value.forEach(emp => {
                    const hrs = parseFloat(day?.hours?.[emp.id]) || 0;
                    if (hrs > 0 && !emp.isManager) {
                        const roundedTip = roundToQuarter(hrs * rate);
                        tips[emp.id] = roundedTip;
                        totalDistributed += roundedTip;
                    } else {
                        tips[emp.id] = 0;
                    }
                });
                return { totalHours, rate, tips, totalDistributed, variance: pool > 0 ? (pool - totalDistributed) : 0 };
            });
        });

        const masterTotalTips = computed(() => dailyData.value.reduce((sum, day) => sum + (parseFloat(day.pool) || 0), 0));
        const masterTotalDistributed = computed(() => calculatedTips.value.reduce((sum, day) => sum + day.totalDistributed, 0));
        const masterTotalVariance = computed(() => masterTotalTips.value - masterTotalDistributed.value);

        const monthlyStats = computed(() => {
            const finalPayouts = {};
            sortedEmployees.value.forEach(emp => {
                let empTotal = 0;
                dailyData.value.forEach((day, dayIndex) => {
                    empTotal += calculatedTips.value[dayIndex]?.tips?.[emp.id] || 0;
                    empTotal += parseFloat(day?.driverTips?.[emp.id]) || 0;
                });
                finalPayouts[emp.id] = empTotal;
            });
            return { finalPayouts };
        });
        const activeYearDisplayData = computed(() => {
            const year = selectedArchiveYear.value;
            const dataMap = {};
            
            const liveHours = {};
            sortedEmployees.value.forEach(emp => {
                let h = 0;
                dailyData.value.forEach(day => {
                    h += parseFloat(day?.hours?.[emp.id]) || 0;
                });
                liveHours[emp.id] = h;
            });

            for (let m = 1; m <= 12; m++) {
                if (yearlyArchives.value[year]?.[m]) {
                    dataMap[m] = yearlyArchives.value[year][m];
                } else {
                    let isLiveMonth = false;
                    if (currentPayPeriod.value) {
                        const [currYr, currMStr] = currentPayPeriod.value.split('-');
                        if (currYr === year && parseInt(currMStr, 10) === m) {
                            isLiveMonth = true;
                        }
                    }

                    if (isLiveMonth) {
                        dataMap[m] = {
                            pool: masterTotalTips.value,
                            totalDistributed: masterTotalDistributed.value,
                            variance: masterTotalVariance.value,
                            payouts: monthlyStats.value.finalPayouts,
                            hours: liveHours,
                            dailyData: dailyData.value,
                            calculatedTips: calculatedTips.value,
                            isLive: true
                        };
                    } else {
                        dataMap[m] = {
                            pool: 0,
                            totalDistributed: 0,
                            variance: 0,
                            payouts: {},
                            hours: {},
                            dailyData: [],
                            calculatedTips: []
                        };
                    }
                }
            }
            return dataMap;
        });

        const activeYearSummary = computed(() => {
            let totalPool = 0;
            let totalDistributed = 0;
            let totalVariance = 0;
            let archivedCount = 0;
            const year = selectedArchiveYear.value;

            for (let m = 1; m <= 12; m++) {
                const mData = activeYearDisplayData.value[m];
                if (yearlyArchives.value[year]?.[m]) {
                    archivedCount++;
                }
                totalPool += parseFloat(mData.pool) || 0;
                totalDistributed += parseFloat(mData.totalDistributed) || 0;
                totalVariance += parseFloat(mData.variance) || 0;
            }
            return { totalPool, totalDistributed, totalVariance, archivedCount };
        });

        const activeYearEmployeeYTD = computed(() => {
            const totals = {};
            sortedEmployees.value.forEach(emp => {
                let tips = 0;
                let hours = 0;
                for (let m = 1; m <= 12; m++) {
                    const mData = activeYearDisplayData.value[m];
                    tips += mData.payouts?.[emp.id] || 0;
                    hours += mData.hours?.[emp.id] || 0;
                }
                totals[emp.id] = { tips, hours };
            });
            return totals;
        });

                    myData.push([]);
                    const myVarianceRow = ['Monthly Rounding Variance', ''];
                    for (let m = 1; m <= 12; m++) {
                        myVarianceRow.push(getMonthDisplayData(year, m).variance || 0);
                    }
                    myVarianceRow.push(summary.totalVariance);
                    myVarianceRow.push('');
                    myData.push(myVarianceRow);

                    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(myData), `Year ${year}`);

                    for (let m = 1; m <= 12; m++) {
                        const mDataObj = getMonthDisplayData(year, m);
                        
                        if (mDataObj && mDataObj.dailyData && mDataObj.dailyData.length > 0 && (mDataObj.isLive || yearlyArchives.value[year]?.[m])) {
                            const mName = getMonthName(m);
                            
                            const mDailyData = [
                                [`RR Sundial ${activeSite.value} LLC - ${mName} ${year} Detailed Daily Breakdown`]
                            ];

                            mDailyData.push([]);
                            mDailyData.push(['--- TIP DISTRIBUTION ($) ---']);
                            const mTipsHeader = ['Last Name', 'First Name'];
                            for (let d = 1; d <= 31; d++) mTipsHeader.push(`Day ${d}`);
                            mTipsHeader.push('Month Total');
                            mDailyData.push(mTipsHeader);

                            const mDailyPoolRow = ['Daily Tip Pool ->', ''];
                            for (let d = 1; d <= 31; d++) {
                                mDailyPoolRow.push(mDataObj.dailyData[d-1]?.pool || 0);
                            }
                            mDailyPoolRow.push(mDataObj.pool || 0);
                            mDailyData.push(mDailyPoolRow);

                            sortedEmployees.value.forEach(emp => {
                                const empRow = [emp.lastName, formatFirstName(emp)];
                                for (let d = 1; d <= 31; d++) {
                                    empRow.push(mDataObj.calculatedTips?.[d-1]?.tips?.[emp.id] || 0);
                                }
                                empRow.push(mDataObj.payouts?.[emp.id] || 0);
                                mDailyData.push(empRow);
                            });

                            const mVarRow = ['Daily Variance ->', ''];
                            for (let d = 1; d <= 31; d++) {
                                mVarRow.push(mDataObj.calculatedTips?.[d-1]?.variance || 0);
                            }
                            mVarRow.push(mDataObj.variance || 0);
                            mDailyData.push(mVarRow);

                            mDailyData.push([]);
                            mDailyData.push([]);
                            mDailyData.push(['--- HOURS WORKED (h) ---']);
                            const mHoursHeader = ['Last Name', 'First Name'];
                            for (let d = 1; d <= 31; d++) mHoursHeader.push(`Day ${d}`);
                            mHoursHeader.push('Month Total');
                            mDailyData.push(mHoursHeader);

                            sortedEmployees.value.forEach(emp => {
                                const empRow = [emp.lastName, formatFirstName(emp)];
                                let monthHours = 0;
                                for (let d = 1; d <= 31; d++) {
                                    const h = parseFloat(mDataObj.dailyData[d-1]?.hours?.[emp.id]) || 0;
                                    empRow.push(h);
                                    monthHours += h;
                                }
                                empRow.push(monthHours);
                                mDailyData.push(empRow);
                            });

                            const monthDrivers = sortedEmployees.value.filter(e => e.isDriver);
                            if (monthDrivers.length > 0) {
                                mDailyData.push([]);
                                mDailyData.push([]);
                                mDailyData.push(['--- DRIVER DIRECT TIPS ($) ---']);
                                const mDrvHeader = ['Last Name', 'First Name'];
                                for (let d = 1; d <= 31; d++) mDrvHeader.push(`Day ${d}`);
                                mDrvHeader.push('Month Total');
                                mDailyData.push(mDrvHeader);

                                monthDrivers.forEach(drv => {
                                    const drvRow = [drv.lastName, formatFirstName(drv)];
                                    let monthDrvTips = 0;
                                    for (let d = 1; d <= 31; d++) {
        const switchSite = async (site) => {
            if (activeSite.value === site) return;
            
            // Security check: restrict users assigned to only one site from viewing other stores
            if (isManagerUnlocked.value && currentUserAccess.value.length > 0 && !currentUserAccess.value.includes(site)) {
                return showAlert(`Access Restricted: Your account does not have permission to access ${site}.`);
            }
            
            // 1. Immediately save current site data before switching
            isSwitchingSites = true;
            await saveState();
            
            // 2. Set new active site & reset tab to master
            activeSite.value = site;
            activeTab.value = 'master';
            localStorage.setItem('sundial-last-site', activeSite.value);
            logAction("Switched Site", `Switched location view to ${site}`);
            
            // 3. Load the target site's independent workspace
            loadSiteData();
        };

        const generateExcelWorkbook = () => {
            const wb = XLSX.utils.book_new();

            const masterData = [
                [`RR Sundial ${activeSite.value} LLC`], [`Tip Tracker/Calculator - ${formattedPayPeriod.value}`], [],
                ['Total Tip Pool (Sum of all days)', masterTotalTips.value], 
                ['Total Distributed (After rounding)', masterTotalDistributed.value],
                ['Rounding Variance', masterTotalVariance.value || 0], []
            ];
            
            const mHeader = ['Last Name', 'First Name'];
            for(let i=1; i<=numDays.value; i++) mHeader.push(`Day ${i}`);
            mHeader.push('Final Total');
            masterData.push(mHeader);

            const poolRow = ['Daily Tip Pool (Locked) ->', ''];
            for (let i = 0; i < numDays.value; i++) {
                poolRow.push(dailyData.value[i]?.pool || 0);
            }
            poolRow.push('');
            masterData.push(poolRow);

            sortedEmployees.value.forEach(emp => {
                const row = [emp.lastName, formatFirstName(emp)];
                for(let i=0; i<numDays.value; i++) {
                    const floorTip = calculatedTips.value[i]?.tips?.[emp.id] || 0;
                    const driverTip = parseFloat(dailyData.value[i]?.driverTips?.[emp.id]) || 0;
                    row.push(floorTip + driverTip);
                }
                row.push(monthlyStats.value.finalPayouts[emp.id] || 0);
                masterData.push(row);
            });
            
            masterData.push([]);
            const mVarianceRow = ['Rounding Overage/Underage', ''];
            for(let i=0; i<numDays.value; i++) mVarianceRow.push(calculatedTips.value[i]?.variance || 0);
            mVarianceRow.push(masterTotalVariance.value || 0);
            masterData.push(mVarianceRow);

            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(masterData), 'Master');

            for (let d = 1; d <= numDays.value; d++) {
                const dayIndex = d - 1;
                const dayDataObj = dailyData.value[dayIndex];
                const dayCalcObj = calculatedTips.value[dayIndex];

                const daySheetData = [
                    [`RR Sundial ${activeSite.value} LLC - Day ${d}`],
                    [`Total Amount of Tips`, dayDataObj?.pool || 0],
                    [],
                    ['Last Name', 'First Name', 'Hours Worked', 'Tip Distribution Amount']
                ];

                sortedEmployees.value.forEach(emp => {
                    const empHours = parseFloat(dayDataObj?.hours?.[emp.id]) || 0;
                    const empTip = parseFloat(dayCalcObj?.tips?.[emp.id]) || 0;
                    daySheetData.push([emp.lastName, formatFirstName(emp), empHours, empTip]);
                });

                daySheetData.push([]);
                daySheetData.push(['Tip-Eligible Totals:', '', dayCalcObj?.totalHours || 0, dayCalcObj?.totalDistributed || 0]);
                daySheetData.push(['Verification Variance:', '', '', dayCalcObj?.variance || 0]);
                
                daySheetData.push([]);
                daySheetData.push(['Driver Delivery Tips']);
                daySheetData.push(['Driver Name', 'Direct Tip Amount']);

                if (driverEmployees.value.length === 0) {
                     daySheetData.push(['No drivers currently configured.']);
                } else {
                    driverEmployees.value.forEach(drv => {
                        const directTip = parseFloat(dayDataObj?.driverTips?.[drv.id]) || 0;
                        daySheetData.push([`${drv.lastName}, ${formatFirstName(drv)}`, directTip]);
                    });
                }

                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daySheetData), `Day ${d}`);
            }
            
            return wb;
        };

        const exportToExcel = () => {
            try {
                const wb = generateExcelWorkbook();
                const periodStr = formattedPayPeriod.value ? `_${formattedPayPeriod.value.replace(/\s+/g, '')}` : '';
                const fileName = `Sundial_${activeSite.value.replace(/\s+/g, '_')}_Tips${periodStr}_${Date.now()}.xlsx`;
                XLSX.writeFile(wb, fileName);
                logAction("Exported Excel", `Exported active period data to ${fileName}`);
            } catch (error) {
                console.error(error);
                showAlert('Error generating Excel file. Please try again.');
            }
        };

        const generateCustomDateReport = () => {
            if (!payrollStartDate.value || !payrollEndDate.value) {
                return showAlert("Please select both a start date and an end date.");
            }

            try {
                const dStart = new Date(payrollStartDate.value + 'T00:00:00');
                const dEnd = new Date(payrollEndDate.value + 'T23:59:59');
                
                const wb = XLSX.utils.book_new();
                const wsData = [
                    [`RR Sundial ${activeSite.value} LLC - Payroll / Custom Date Report`], 
                    ['Period:', dStart.toLocaleDateString(), 'to', dEnd.toLocaleDateString()], 
                    []
                ];
                wsData.push(['Last Name', 'First Name', 'Total Hours', 'Total Tips ($)']);

                const totals = {};
                
                const processMonthData = (year, mIdx, mData) => {
                    if (!mData || !mData.dailyData) return;
                    for (let d = 0; d < 31; d++) {
                        const currentDay = new Date(year, mIdx - 1, d + 1, 12, 0, 0);
                        if (currentDay.getMonth() !== mIdx - 1) continue; 

                        if (currentDay >= dStart && currentDay <= dEnd) {
                            const dayObj = mData.dailyData[d];
                            const calcObj = mData.calculatedTips ? mData.calculatedTips[d] : null;
                            
                            if (dayObj && dayObj.hours) {
                                Object.keys(dayObj.hours).forEach(empId => {
                                    if (!totals[empId]) totals[empId] = { hours: 0, tips: 0 };
                                    totals[empId].hours += parseFloat(dayObj.hours[empId]) || 0;
                                });
                            }
                            if (calcObj && calcObj.tips) {
                                Object.keys(calcObj.tips).forEach(empId => {
                                    if (!totals[empId]) totals[empId] = { hours: 0, tips: 0 };
                                    totals[empId].tips += parseFloat(calcObj.tips[empId]) || 0;
                                });
                            }
                            if (dayObj && dayObj.driverTips) {
                                Object.keys(dayObj.driverTips).forEach(empId => {
                                    if (!totals[empId]) totals[empId] = { hours: 0, tips: 0 };
                                    totals[empId].tips += parseFloat(dayObj.driverTips[empId]) || 0;
                                });
                            }
                        }
                    }
                };

                if (yearlyArchives.value) {
                    for (const year in yearlyArchives.value) {
                        for (const mIdx in yearlyArchives.value[year]) {
                            processMonthData(parseInt(year), parseInt(mIdx), yearlyArchives.value[year][mIdx]);
                        }
                    }
                }

                if (currentPayPeriod.value) {
                    const [currYr, currM] = currentPayPeriod.value.split('-');
                    processMonthData(parseInt(currYr), parseInt(currM), {
                        dailyData: dailyData.value,
                        calculatedTips: calculatedTips.value
                    });
                }

                let hasData = false;
                employees.value.forEach(emp => {
                    const t = totals[emp.id];
                    if (t && (t.hours > 0 || t.tips > 0)) {
                        wsData.push([emp.lastName, formatFirstName(emp), Math.round(t.hours * 100) / 100, Math.round(t.tips * 100) / 100]);
                        hasData = true;
                    }
                });

                if (!hasData) {
                    return showAlert('No recorded hours or tips found in the ledger for the selected dates.');
                }

                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(wsData), 'Payroll Report');
                XLSX.writeFile(wb, `Sundial_${activeSite.value.replace(/\s+/g, '_')}_DateRange_Report.xlsx`);
                
                logAction('Exported Custom Report', `Exported date range report from ${payrollStartDate.value} to ${payrollEndDate.value}`);
                showPayrollModal.value = false;
            } catch(err) {
                console.error(err);
                showAlert('Error generating report: ' + err.message);
            }
        };

        const clearData = () => {
            showConfirm(`Are you sure you want to delete all hours and tips for ${activeSite.value}? (Your shared employee roster will be saved).`, () => {
                dailyData.value = createEmptyDailyData(numDays.value);
                logAction("Reset Pay Period", `Cleared all daily input values for ${activeSite.value}.`);
                saveState();
            });
        };

        const addEmployee = () => {
            if (!newEmp.value.first.trim() || !newEmp.value.last.trim()) return showAlert("Please enter both a first and last name.");
            
            const assignedSites = [];
            if (newEmp.value.siteRB) assignedSites.push('Red Bluff');
            if (newEmp.value.siteRD) assignedSites.push('Redding');
            
            if (assignedSites.length === 0) {
                return showAlert("Please select at least one site location for this employee.");
            }

            employees.value.push({
                id: 'emp_' + Date.now() + Math.random().toString(36).substring(2, 9),
                firstName: newEmp.value.first.trim(), 
                lastName: newEmp.value.last.trim(), 
                isDriver: newEmp.value.isDriver, 
                isManager: newEmp.value.isManager,
                tempId: newEmp.value.tempId ? newEmp.value.tempId.trim() : '',
                sites: assignedSites
            });
            logAction("Added Employee", `Added ${newEmp.value.first.trim()} ${newEmp.value.last.trim()} to store roster (${assignedSites.join(', ')}).`);
            newEmp.value = { first: '', last: '', tempId: '', isDriver: false, isManager: false, siteRB: true, siteRD: true };
            saveState();
        };

        const toggleEmployeeSite = (emp, site) => {
            if (!emp.sites || !Array.isArray(emp.sites)) {
                emp.sites = ['Red Bluff', 'Redding'];
            }
            if (emp.sites.includes(site)) {
                if (emp.sites.length === 1) {
                    return showAlert("An employee must belong to at least one site location.");
                }
                emp.sites = emp.sites.filter(s => s !== site);
            } else {
                emp.sites.push(site);
            }
            logAction("Updated Employee Site Access", `Updated site access for ${emp.firstName} ${emp.lastName}: ${emp.sites.join(', ')}`);
            saveState();
        };

        const removeEmployee = (id) => { 
        const syncDataToExtension = () => {
            if (activeExtensionIframe.value && activeExtensionIframe.value.contentWindow) {
                const cleanEmployees = JSON.parse(JSON.stringify(sortedEmployees.value));
                const cleanDailyData = JSON.parse(JSON.stringify(dailyData.value));
                
                const payload = {
                    type: 'SUNDIAL_DATA_SYNC',
                    site: activeSite.value,
                    period: formattedPayPeriod.value,
                    employees: cleanEmployees,
                    data: cleanDailyData,
                    calculatedTips: JSON.parse(JSON.stringify(calculatedTips.value)),
                    masterTotalTips: masterTotalTips.value,
                    masterTotalDistributed: masterTotalDistributed.value,
                    masterTotalVariance: masterTotalVariance.value,
                    monthlyPayouts: JSON.parse(JSON.stringify(monthlyStats.value.finalPayouts)),
                    yearlyArchives: JSON.parse(JSON.stringify(yearlyArchives.value))
                };
                
                activeExtensionIframe.value.contentWindow.postMessage(payload, '*');
                logAction("API Sync", `Pushed live data payload to Virtual Tool: ${activeExtension.value.name}`);
            }
        };

        const generateMockData = () => {
            showConfirm("DEV MODE: Overwrite the current active period with 31 days of random mock data?", () => {
                if (employees.value.length === 0) {
                    employees.value = [
                        { id: 'mock_1', lastName: 'Doe', firstName: 'John', isDriver: false, isManager: false },
                        { id: 'mock_2', lastName: 'Smith', firstName: 'Jane', isDriver: true, isManager: false },
                        { id: 'mock_3', lastName: 'Manager', firstName: 'Test', isDriver: false, isManager: true }
                    ];
                }
                const newDailyData = createEmptyDailyData(numDays.value);
                for (let d = 0; d < numDays.value; d++) {
                    newDailyData[d].pool = Math.floor(Math.random() * 701) + 200;
                    employees.value.forEach(emp => {
                        if (Math.random() > 0.25) {
                            const possibleHours = [4, 4.5, 5, 6, 7, 7.5, 8, 8.5, 9, 10];
                            newDailyData[d].hours[emp.id] = possibleHours[Math.floor(Math.random() * possibleHours.length)];
                            if (emp.isDriver) {
                                newDailyData[d].driverTips[emp.id] = Math.floor(Math.random() * 41) + 5;
                            }
                        }
                    });
                }
                dailyData.value = newDailyData;
                logAction("Generated Mock Data", "Dev injected a full month of random mock data.");
                saveState();
                showAlert("31 days of random mock data generated successfully!");
            });
        };

        const applySnapshot = (data) => {
            const currentDataStr = JSON.stringify({
                dailyData: dailyData.value,
                numDays: numDays.value,
                auditLogs: auditLogs.value,
                currentPayPeriod: currentPayPeriod.value,
                yearlyArchives: yearlyArchives.value
            });
            
            const newDataStr = JSON.stringify({
                dailyData: data.dailyData || createEmptyDailyData(31),
                numDays: data.numDays || 31,
                auditLogs: data.auditLogs || [],
                currentPayPeriod: data.currentPayPeriod || '',
                yearlyArchives: data.yearlyArchives || {}
            });

            if (currentDataStr === newDataStr) return;

            numDays.value = data.numDays || 31;
            let loadedData = data.dailyData || createEmptyDailyData(31);
            if (loadedData.length < 31) {
                const padding = createEmptyDailyData(31 - loadedData.length);
                loadedData = [...loadedData, ...padding];
            }
            dailyData.value = ensureThirtyOneDays(loadedData);
            auditLogs.value = data.auditLogs || [];
            if (data.currentPayPeriod) currentPayPeriod.value = data.currentPayPeriod;
            yearlyArchives.value = data.yearlyArchives || {};
            
            remoteStateHash = newDataStr;
        };

        const saveState = async () => {
            if (isUndoing || isSwitchingSites || !isDbConnected.value || !auth.currentUser) return;
            
            const payload = {
                dailyData: dailyData.value, 
                numDays: numDays.value, 
                auditLogs: auditLogs.value,
                currentPayPeriod: currentPayPeriod.value,
                yearlyArchives: yearlyArchives.value
            };

            const payloadStr = JSON.stringify(payload);
            if (payloadStr === remoteStateHash) return;

            try {
                const siteId = activeSite.value.replace(/\s+/g, '').toLowerCase();
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_sites', siteId), payload);
                remoteStateHash = payloadStr;
            } catch (e) {
                console.error("Failed to push data to cloud:", e);
            }
        };

        const pushHistory = () => {
            if (isUndoing || isSwitchingSites) return;
            const snap = JSON.stringify({ e: employees.value, d: dailyData.value, n: numDays.value, p: currentPayPeriod.value });
            if (historyIndex.value < history.value.length - 1) history.value = history.value.slice(0, historyIndex.value + 1);
            if (history.value.length > 0 && history.value[historyIndex.value] === snap) return;
            history.value.push(snap);
            if (history.value.length > 30) history.value.shift();
            historyIndex.value = history.value.length - 1;
            saveState();
        };

        watch([dailyData, numDays, currentPayPeriod], () => pushHistory(), { deep: true });

        const undo = () => {
            if (historyIndex.value > 0) {
                isUndoing = true; historyIndex.value--;
                const snap = JSON.parse(history.value[historyIndex.value]);
                employees.value = snap.e || employees.value; 
                
                let loadedData = snap.d;
                if (loadedData.length < 31) {
                    const padding = createEmptyDailyData(31 - loadedData.length);
                    loadedData = [...loadedData, ...padding];
                }
                dailyData.value = ensureThirtyOneDays(loadedData);
                
                numDays.value = 31;
                if (snap.p) currentPayPeriod.value = snap.p;
                saveState();
                setTimeout(() => isUndoing = false, 50);
            }
        };

        const loadSiteData = () => {
            if (!isDbConnected.value || !auth.currentUser) return;
            
            if (unsubscribeSite) unsubscribeSite();
            const siteId = activeSite.value.replace(/\s+/g, '').toLowerCase();
            
            unsubscribeSite = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_sites', siteId), (docSnap) => {
                if (docSnap.exists()) {
                    applySnapshot(docSnap.data());
                } else {
                    numDays.value = 31;
                    dailyData.value = createEmptyDailyData(31);
                    auditLogs.value = [];
                    yearlyArchives.value = {};
                }
                
                history.value = [];
                historyIndex.value = -1;
                isSwitchingSites = false;
                pushHistory();
                nextTick(() => lucide.createIcons());
            }, (error) => console.error("Error fetching site state:", error));
        };

        const initAuth = async () => {
            try {
                await signInAnonymously(auth);
            } catch (e) {
                console.error("Auth Error:", e);
                if (e.code === 'auth/admin-restricted-operation' || e.code === 'auth/operation-not-allowed') {
                    showAlert("Firebase Auth Error: Please ensure 'Anonymous' Sign-In is enabled in your Firebase Console (Build -> Authentication -> Sign-in method).");
                }
            }
        };

        onMounted(async () => {
            const lastSite = localStorage.getItem('sundial-last-site');
            if (lastSite && (lastSite === 'Red Bluff' || lastSite === 'Redding')) activeSite.value = lastSite;
            
            await initAuth();
            if (!auth.currentUser) {
                showAlert("Failed to authenticate with cloud database.");
                return;
            }

            // Global settings listener (Loads systemUsers, extensions, and the shared employee roster)
            onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_globals', 'settings'), (docSnap) => {
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    if (data.systemUsers) systemUsers.value = data.systemUsers;
                    if (data.extensions) extensions.value = data.extensions;
                    if (data.employees) employees.value = data.employees;
                } else {
                    setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'sundial_globals', 'settings'), {
                        systemUsers: defaultSystemUsers,
                        extensions: [],
                        employees: []
                    });
                }
            }, (error) => console.error("Global Setting fetch error:", error));

            isDbConnected.value = true;
            loadSiteData();
            nextTick(() => lucide.createIcons());
            
            window.addEventListener('mousemove', resetTimerActivity);
            window.addEventListener('keydown', (e) => {
                resetTimerActivity();
                if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); } 
            });
            
            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'SUNDIAL_REQUEST_DATA') {
                    syncDataToExtension();
                }
            });
        });

        watch(activeTab, () => nextTick(() => lucide.createIcons()));

        return {
            activeSite, switchSite, numDays, employees, sortedEmployees, driverEmployees, dailyData, activeTab,
            showEmployeeModal, showPermissionsModal, newEmp, newUserAuth, editingPin, historyIndex, monthlyStats,
            toggleEmployeeSite,
            addEmployee, removeEmployee, clearData, exportToExcel, undo, generateMockData, quickLogin,
            modal, closeModal, confirmModal, formatFirstName, isFullTimeId,
            loggedInUser, isManagerUnlocked, currentUserAccess, isDevUser, hasPermissionAccess, hasRoleAccess, pinInput, handleLogin, forceLock,
            systemUsers, saveSystemUser, editSystemUser, cancelEdit, removeSystemUser, resetPersonalPin, ROLE_TIERS, currentUserRoleLevel, availableRolesToAssign, getRoleBadgeClass,
            setup2FA, pending2FAUserPin, save2FASetup,
            extensions, showExtensionModal, activeExtension, activeExtensionIframe, newExtension, isDraggingFile, handleFileDrop, launchExtension, closeExtension, addExtension, removeExtension, syncDataToExtension,
            editingExtension, editExtension, updateExtension, cancelEditExtension,
            showImportModal, isDraggingExcel, isDraggingOCR, isProcessingOCR, ocrStatus, ocrProgress, pastedRawText, handleGlobalPaste, processPastedText, handleExcelDrop, importExcel, handleOCRDrop, importOCR,
            showPayrollModal, payrollStartDate, payrollEndDate, generateCustomDateReport,
            auditLogs, logAction, clearAuditLog, exportAuditLog,
            timeRemaining, formattedTimeRemaining, showTimeoutModal, extendSession,
            startDrag, onDrag, stopDrag,
            currentPayPeriod, formattedPayPeriod, handlePeriodChange,
            yearlyArchives, selectedArchiveYear, multiYearDisplayMode, availableArchiveYears, getMonthName, addNewYearTab, getYearlySummary, getEmployeeYTDTotal, archiveCurrentMonth, exportHistoricalLedger,
            selectedArchivedMonthDetail, archivedMonthDisplayMode, closeArchivedMonthDetail,
            scrollToMonth, isCurrentPayPeriodMonth, getMonthDisplayData,
            activeYearDisplayData, activeYearSummary, activeYearEmployeeYTD,
            refreshIcons, isDbConnected
        };
    }
});

app.mount('#app');
