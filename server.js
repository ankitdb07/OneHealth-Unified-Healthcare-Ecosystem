const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs-extra');
const { spawn } = require('child_process');

const app = express();

// --- MIDDLEWARE ---
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);

// --- DATABASE CONNECTION ---
mongoose.connect('mongodb://localhost:27017/onehealth_db')
    .then(() => console.log("✅ OneHealth Centralized Repository Connected"))
    .catch(err => console.error("❌ Database Connection Failed:", err));

// --- MODELS ---
const Record = mongoose.model('Record', new mongoose.Schema({
    patientId: String, 
    uploadedBy: String, 
    type: String, 
    fileName: String,
    fileUrl: String,      
    aiSuggestion: { type: String, default: "Analyzing..." }, 
    date: { type: Date, default: Date.now }
}));

const Otp = mongoose.model('Otp', new mongoose.Schema({
    patientId: String, 
    code: String,
    createdAt: { type: Date, default: Date.now, expires: 1200 } // 20-minute validity
}));

// --- STORAGE CONFIGURATION ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        cb(null, `OH-${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// --- API ROUTES ---

// 1. Upload Route with Advanced AI Integration
app.post('/api/records/upload', upload.single('reportFile'), async (req, res) => {
    try {
        let { patientId, uploadedBy, type } = req.body;
        const cleanId = patientId.trim().toUpperCase(); // Ensure ID consistency
        
        const newRecord = new Record({
            patientId: cleanId,
            uploadedBy,
            type,
            fileName: req.file.originalname,
            fileUrl: `/uploads/${req.file.filename}`.replace(/\\/g, "/"),
            aiSuggestion: "Awaiting AI Engine..." 
        });

        const savedRecord = await newRecord.save();

        const python = spawn('py', [
            path.join(__dirname, '../ai-engine/ai_logic.py'), 
            req.file.path 
        ]);

        let aiResult = "";
        python.stdout.on('data', (data) => {
            aiResult += data.toString();
        });

        python.on('close', async (code) => {
            const finalSuggestion = aiResult.trim() || "Analysis complete.";
            
            // AI Security Block: Deletes file if flagged
            if (finalSuggestion.includes("❌ SECURITY ERROR")) {
                console.log(`⚠️ Security Block: Removing non-medical file ${savedRecord.fileName}`);
                const filePath = path.join(__dirname, savedRecord.fileUrl.replace(/^\//, ""));
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                await Record.findByIdAndDelete(savedRecord._id);
            } else {
                await Record.findByIdAndUpdate(savedRecord._id, { aiSuggestion: finalSuggestion });
                
                if (finalSuggestion.includes("🚨 CRITICAL")) {
                    console.log(`📢 URGENT: Critical medical markers detected for Patient ${cleanId}`);
                }
                console.log(`✅ AI successfully filled DB for: ${savedRecord.fileName}`);
            }
        });

        res.json({ msg: "File Uploaded Successfully", record: savedRecord });

    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).json({ error: "Upload Failed" });
    }
});

// 2. Fetch Records Route (Patient Side)
app.get('/api/records/my/:patientId', async (req, res) => {
    const cleanId = req.params.patientId.trim().toUpperCase();
    const records = await Record.find({ patientId: cleanId }).sort({ date: -1 });
    res.json(records);
});

// 3. Merged Delete Route
app.delete('/api/records/delete/:id', async (req, res) => {
    try {
        const record = await Record.findById(req.params.id);
        if (!record) return res.status(404).json({ error: "Record not found" });

        const relativePath = record.fileUrl.startsWith('/') ? record.fileUrl.substring(1) : record.fileUrl;
        const filePath = path.join(__dirname, relativePath);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Deleted file: ${filePath}`);
        }

        await Record.findByIdAndDelete(req.params.id);
        res.json({ msg: "Success: Removed from Cloud" });
    } catch (err) {
        res.status(500).json({ error: "Delete failed" });
    }
});

// 4. Hard Revocation OTP Logic
app.post('/api/otp/generate', async (req, res) => {
    try {
        const { patientId } = req.body;
        const cleanId = patientId.trim().toUpperCase();
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        // Deletes old codes to force immediate logout of active doctor sessions
        await Otp.deleteMany({ patientId: cleanId }); 
        const newOtp = new Otp({ patientId: cleanId, code, createdAt: new Date() });
        await newOtp.save();
        
        console.log(`🔒 New Session for ${cleanId}. Old access revoked. New OTP: ${code}`);
        res.json({ otp: code });
    } catch (err) {
        res.status(500).json({ error: "OTP Generation Failed" });
    }
});

// 5. Route to provide data to the Chart
app.get('/api/stats/recovery/:patientId', async (req, res) => {
    const cleanId = req.params.patientId.trim().toUpperCase();
    const records = await Record.find({ patientId: cleanId }).limit(5);
    res.json(records);
});

// 6. Hospital Specific Fetch Route
app.get('/api/hospital/fetch/:patientId', async (req, res) => {
    const cleanId = req.params.patientId.trim().toUpperCase();
    const records = await Record.find({ 
        patientId: cleanId,
        aiSuggestion: { $not: /❌ SECURITY ERROR/ } 
    }).sort({ date: -1 });
    res.json(records);
});

// 7. Secure Doctor & Hospital Verification & Record Access
app.post('/api/doctor/verify', async (req, res) => {
    let { patientId, otp } = req.body;
    const cleanId = patientId.trim().toUpperCase();
    
    try {
        const validOtp = await Otp.findOne({ patientId: cleanId, code: otp });
        
        if (validOtp) {
            const records = await Record.find({ 
                patientId: cleanId,
                aiSuggestion: { $not: /❌ SECURITY ERROR/ }
            }).sort({ date: -1 });
            
            res.json({ success: true, records });
        } else {
            // Triggers automatic logout in portals
            res.status(401).json({ success: false, msg: "Session Revoked or Expired" });
        }
    } catch (err) {
        console.error("Verification Error:", err);
        res.status(500).json({ error: "Verification Failed" });
    }
});

// 8. Hospital Manual Upload Route (No File Required)
app.post('/api/records/upload-manual', async (req, res) => {
    try {
        const { patientId, uploadedBy, type, aiSuggestion } = req.body;
        const cleanId = patientId.trim().toUpperCase();

        const newRecord = new Record({
            patientId: cleanId,
            uploadedBy: uploadedBy || "Institutional Source",
            type: type || "Manual Entry",
            fileName: `MANUAL-${type}-${Date.now()}.txt`,
            fileUrl: "/uploads/manual_entry.pdf", // Placeholder URL
            aiSuggestion: aiSuggestion || "Manual Entry Verified",
            date: new Date()
        });
        await newRecord.save();
        console.log(`🏥 Hospital Upload: New record synced for Patient ${cleanId}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Hospital upload failed" });
    }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 OneHealth Server Live at Port 5000`));