package com.aegistrack;

import javafx.application.Application;
import javafx.application.Platform;
import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.geometry.Insets;
import javafx.geometry.Pos;
import javafx.scene.Scene;
import javafx.scene.control.*;
import javafx.scene.control.cell.PropertyValueFactory;
import javafx.scene.layout.*;
import javafx.stage.Stage;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import javafx.scene.web.WebView;
import javafx.scene.web.WebEngine;

public class AegisTrackDashboard extends Application {

    private static String BACKEND_URL = "https://aegistrack-backend.onrender.com";
    private static String FRONTEND_URL = "https://aegistrack.vercel.app";
    private static final HttpClient httpClient = HttpClient.newHttpClient();
    private static final ObjectMapper objectMapper = new ObjectMapper();
    private StackPane contentArea;
    private java.util.Map<String, VBox> sectionViews = new java.util.HashMap<>();
    private java.util.List<Button> sidebarButtons = new java.util.ArrayList<>();
    private static final String SIDEBAR_BUTTON_DEFAULT = "-fx-background-color: transparent; -fx-text-fill: #9acddf; -fx-font-size: 12px; -fx-alignment: CENTER_LEFT; -fx-padding: 10 14 10 14;";
    private static final String SIDEBAR_BUTTON_ACTIVE = "-fx-background-color: rgba(0, 242, 255, 0.18); -fx-text-fill: #00f2ff; -fx-font-size: 12px; -fx-font-weight: bold; -fx-alignment: CENTER_LEFT; -fx-padding: 10 14 10 14;";

    static {
        loadEnv();
    }

    private static void loadEnv() {
        try {
            java.nio.file.Path envPath = java.nio.file.Paths.get("..", "backend", ".env");
            if (!java.nio.file.Files.exists(envPath)) {
                envPath = java.nio.file.Paths.get(".env");
            }
            if (!java.nio.file.Files.exists(envPath)) {
                envPath = java.nio.file.Paths.get("backend", ".env");
            }
            if (java.nio.file.Files.exists(envPath)) {
                java.util.List<String> lines = java.nio.file.Files.readAllLines(envPath);
                for (String line : lines) {
                    line = line.trim();
                    if (line.startsWith("#")) continue;
                    if (line.contains("=")) {
                        String[] parts = line.split("=", 2);
                        String key = parts[0].trim();
                        String value = parts[1].trim();
                        if ("BACKEND_URL".equals(key)) {
                            BACKEND_URL = value;
                        } else if ("FRONTEND_URL".equals(key)) {
                            FRONTEND_URL = value;
                        }
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("Error reading .env: " + e.getMessage());
        }
        System.out.println("AegisTrack CONFIGURATION LOADED:");
        System.out.println("BACKEND_URL: " + BACKEND_URL);
        System.out.println("FRONTEND_URL: " + FRONTEND_URL);
    }

    private WebView portalWebView;

    private TextField deviceIdField;
    private TextField tokenField;
    private TextField usernameField;
    private javafx.scene.control.PasswordField passwordField;
    private javafx.scene.control.ComboBox<String> deviceComboBox;
    private Label authStatusLabel;
    private Label statusLabel;
    private Label connectionStatusLabel;
    private Label latitudeLabel;
    private Label longitudeLabel;
    private Label accuracyLabel;
    private Label timestampLabel;
    private TableView<DeviceLocation> deviceTable;
    private ObservableList<DeviceLocation> deviceList = FXCollections.observableArrayList();
    private ListView<String> enrollmentRequestsList;
    private ObservableList<String> enrollmentRequests = FXCollections.observableArrayList();
    private ObservableList<String> registeredIdsList = FXCollections.observableArrayList();
    private ObservableList<String> consentItems = FXCollections.observableArrayList();
    private ObservableList<String> auditItems = FXCollections.observableArrayList();
    private ObservableList<String> registryItems = FXCollections.observableArrayList();
    private ObservableList<String> alertItems = FXCollections.observableArrayList();
    private ObservableList<String> threatItems = FXCollections.observableArrayList();
    private ObservableList<String> operatorItems = FXCollections.observableArrayList();
    private ListView<String> consentListView;
    private ListView<String> auditListView;
    private ListView<String> registryListView;
    private ListView<String> alertListView;
    private ListView<String> threatListView;
    private ListView<String> operatorsListView;
    
    // Live Monitoring Metric Labels
    private Label activeNodesMetricLabel;
    private Label alertsMetricLabel;
    private Label avgAccuracyMetricLabel;
    private Label linkStatusMetricLabel;
    private Label totalDevicesLabel;
    private Label activeConsentsLabel;
    private Label recentAlertsLabel;
    private Label systemHealthLabel;
    private TextField geofenceDeviceField;
    private TextField geofenceLatField;
    private TextField geofenceLngField;
    private TextField geofenceRadiusField;
    private WebSocket webSocket;
    private String currentDeviceId = "";

    public static void main(String[] args) {
        launch(args);
    }

    @Override
    public void start(Stage primaryStage) {
        primaryStage.setTitle("AegisTrack // TACTICAL MONITOR");
        
        BorderPane root = new BorderPane();
        root.getStyleClass().add("root");
        
        // SIDEBAR
        VBox sidebar = createSidebar();
        root.setLeft(sidebar);
        
        // MAIN CONTENT AREA
        contentArea = new StackPane();
        sectionViews = new java.util.HashMap<>();
        sidebarButtons = new java.util.ArrayList<>();

        contentArea.getChildren().addAll(
            createOverviewSection(),
            createLiveMonitoringSection(),
            createLiveMonitorPortalSection(),
            createEnrollmentRequestsSection(),
            createConsentManagementSection(),
            createGeofenceAdministrationSection(),
            createAlertCenterSection(),
            createThreatIntelSection(),
            createAuditLogsSection(),
            createDeviceRegistrySection(),
            createReportsSection(),
            createOperatorManagementSection(),
            createHealthMonitoringSection(),
            createSettingsSection()
        );
        switchSection("Dashboard Overview");
        root.setCenter(contentArea);
        
        Scene scene = new Scene(root, 1100, 760);
        
        // Apply CSS
        try {
            String cssPath = new java.io.File("style.css").toURI().toURL().toExternalForm();
            scene.getStylesheets().add(cssPath);
        } catch (Exception e) {
            System.err.println("Could not load CSS: " + e.getMessage());
        }
        
        primaryStage.setScene(scene);
        primaryStage.setOnCloseRequest(e -> {
            if (webSocket != null) {
                webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "shutting down");
            }
        });
        primaryStage.show();
    }

    private VBox createSidebar() {
        VBox sidebar = new VBox(14);
        sidebar.setPadding(new Insets(24));
        sidebar.setPrefWidth(240);
        sidebar.setStyle("-fx-background-color: #07101a; -fx-border-color: rgba(0, 242, 255, 0.16); -fx-border-width: 0 1 0 0;");

        Label logo = new Label("AegisTrack");
        logo.setStyle("-fx-text-fill: #00f2ff; -fx-font-size: 18px; -fx-font-weight: bold;");
        Label tagline = new Label("CDEAS | CONSENT AUTHORIZATION");
        tagline.setStyle("-fx-text-fill: #7a8a99; -fx-font-size: 10px; -fx-padding: 0 0 12 0;");

        VBox navGroup = new VBox(8);
        String[] navLabels = {
            "Dashboard Overview",
            "Live Device Monitoring",
            "Live Monitor Portal",
            "Device Enrollment Requests",
            "Consent Management",
            "Geofence Administration",
            "Alert Center",
            "Threat Intelligence",
            "Audit Logs",
            "Device Registry",
            "Reports & Analytics",
            "Operator Management",
            "System Health",
            "Settings"
        };

        String defaultStyle = "-fx-background-color: transparent; -fx-text-fill: #9acddf; -fx-font-size: 12px; -fx-alignment: CENTER_LEFT; -fx-padding: 10 14 10 14;";
        String activeButtonStyle = "-fx-background-color: rgba(0, 242, 255, 0.18); -fx-text-fill: #00f2ff; -fx-font-size: 12px; -fx-font-weight: bold; -fx-alignment: CENTER_LEFT; -fx-padding: 10 14 10 14;";

        for (String label : navLabels) {
            Button navButton = new Button(label);
            navButton.setMaxWidth(Double.MAX_VALUE);
            navButton.setStyle(defaultStyle);
            navButton.setOnAction(e -> {
                switchSection(label);
                sidebarButtons.forEach(btn -> btn.setStyle(btn == navButton ? activeButtonStyle : defaultStyle));
            });
            sidebarButtons.add(navButton);
            navGroup.getChildren().add(navButton);
        }

        Separator divider = new Separator();
        divider.setOpacity(0.2);

        Button refreshBtn = new Button("REFRESH DEVICES");
        refreshBtn.setMaxWidth(Double.MAX_VALUE);
        refreshBtn.setOnAction(e -> refreshAllDevices());
        refreshBtn.getStyleClass().add("button-outline");

        connectionStatusLabel = new Label("WS: Disconnected");
        connectionStatusLabel.setStyle("-fx-text-fill: #7a8a99; -fx-font-size: 10px;");

        sidebar.getChildren().addAll(logo, tagline, navGroup, divider, refreshBtn, connectionStatusLabel);
        return sidebar;
    }

    private void switchSection(String key) {
        sectionViews.forEach((section, pane) -> pane.setVisible(section.equals(key)));
        if (sidebarButtons != null) {
            sidebarButtons.forEach(btn -> btn.setStyle(btn.getText().equals(key) ? SIDEBAR_BUTTON_ACTIVE : SIDEBAR_BUTTON_DEFAULT));
        }
        if ("Live Monitor Portal".equals(key) && portalWebView != null) {
            portalWebView.getEngine().load(FRONTEND_URL + "/pages/live-monitor.html");
        }
    }

    private VBox createOverviewSection() {
        VBox container = new VBox(20);
        container.setPadding(new Insets(25));

        // ── OPERATOR LOGIN PANEL ───────────────────────────────────────────
        VBox loginPanel = new VBox(12);
        loginPanel.setPadding(new Insets(18));
        loginPanel.getStyleClass().add("cyber-panel");

        Label loginTitle = new Label("OPERATOR AUTHENTICATION");
        loginTitle.getStyleClass().add("panel-title");

        // Username row
        HBox userRow = new HBox(10);
        userRow.setAlignment(Pos.CENTER_LEFT);
        Label userLbl = new Label("USERNAME:");
        userLbl.setPrefWidth(100);
        usernameField = new TextField();
        usernameField.setPromptText("Operator ID...");
        usernameField.setPrefWidth(200);
        userRow.getChildren().addAll(userLbl, usernameField);

        // Password row
        HBox passRow = new HBox(10);
        passRow.setAlignment(Pos.CENTER_LEFT);
        Label passLbl = new Label("ACCESS CODE:");
        passLbl.setPrefWidth(100);
        passwordField = new javafx.scene.control.PasswordField();
        passwordField.setPromptText("••••••••");
        passwordField.setPrefWidth(200);
        passRow.getChildren().addAll(passLbl, passwordField);

        // Token display (read-only, auto-filled on login)
        HBox tokenRow = new HBox(10);
        tokenRow.setAlignment(Pos.CENTER_LEFT);
        Label tokenLbl = new Label("SESSION TOKEN:");
        tokenLbl.setPrefWidth(100);
        tokenField = new TextField();
        tokenField.setPromptText("Auto-filled on login — or paste JWT here manually...");
        tokenField.setEditable(true);   // allow manual paste
        tokenField.setPrefWidth(420);
        tokenField.setStyle("-fx-opacity: 1.0; -fx-font-size: 10px;");
        tokenRow.getChildren().addAll(tokenLbl, tokenField);

        // Login button + status
        HBox loginBtnRow = new HBox(15);
        loginBtnRow.setAlignment(Pos.CENTER_LEFT);
        Button loginBtn = new Button("AUTHENTICATE");
        loginBtn.setPrefHeight(38);
        loginBtn.setPrefWidth(140);
        loginBtn.setOnAction(e -> loginAndFetchToken());

        // Allow Enter key to trigger login
        passwordField.setOnAction(e -> loginAndFetchToken());
        usernameField.setOnAction(e -> passwordField.requestFocus());

        authStatusLabel = new Label("AWAITING_CREDENTIALS");
        authStatusLabel.setStyle("-fx-text-fill: #7a8a99; -fx-font-size: 10px;");
        loginBtnRow.getChildren().addAll(loginBtn, authStatusLabel);

        loginPanel.getChildren().addAll(loginTitle, userRow, passRow, tokenRow, loginBtnRow);

        // ── DEVICE TO TRACE PANEL ──────────────────────────────────────────
        HBox tracePanel = new HBox(15);
        tracePanel.setPadding(new Insets(15));
        tracePanel.getStyleClass().add("cyber-panel");
        tracePanel.setAlignment(Pos.CENTER_LEFT);

        Label traceTitle = new Label("DEVICE TO TRACE:");
        traceTitle.setStyle("-fx-text-fill: #00f2ff; -fx-font-weight: bold;");

        deviceComboBox = new javafx.scene.control.ComboBox<>();
        deviceComboBox.setPromptText("-- SELECT NODE --");
        deviceComboBox.setPrefWidth(250);
        deviceComboBox.setOnAction(e -> {
            String selected = deviceComboBox.getValue();
            if (selected != null && !selected.isEmpty()) {
                deviceIdField.setText(selected);
                currentDeviceId = selected;
                fetchDeviceLocation();
            }
        });

        Button refreshNodesBtn = new Button("REFRESH NODES");
        refreshNodesBtn.setOnAction(e -> refreshAllDevices());

        Button connectBtn = new Button("INITIATE LINK");
        connectBtn.setPrefHeight(38);
        connectBtn.setOnAction(e -> connectWebSocket());

        // Hidden deviceIdField (kept for internal use)
        deviceIdField = new TextField();
        deviceIdField.setVisible(false);
        deviceIdField.setManaged(false);

        tracePanel.getChildren().addAll(traceTitle, deviceComboBox, refreshNodesBtn, connectBtn);

        // TELEMETRY DISPLAY
        GridPane telemetryPanel = new GridPane();
        telemetryPanel.setHgap(20);
        telemetryPanel.setVgap(15);
        telemetryPanel.setPadding(new Insets(20));
        telemetryPanel.getStyleClass().add("cyber-panel");
        
        latitudeLabel = new Label("LATITUDE: --");
        latitudeLabel.getStyleClass().add("data-label");
        longitudeLabel = new Label("LONGITUDE: --");
        longitudeLabel.getStyleClass().add("data-label");
        accuracyLabel = new Label("ACCURACY: --");
        accuracyLabel.getStyleClass().add("data-label");
        timestampLabel = new Label("SYNC: --");
        timestampLabel.getStyleClass().add("data-label");
        statusLabel = new Label("STATUS: IDLE");
        statusLabel.getStyleClass().add("status-text");
        
        telemetryPanel.add(new Label("REAL-TIME SENSORS"), 0, 0, 2, 1);
        telemetryPanel.add(latitudeLabel, 0, 1);
        telemetryPanel.add(longitudeLabel, 1, 1);
        telemetryPanel.add(accuracyLabel, 0, 2);
        telemetryPanel.add(timestampLabel, 1, 2);
        telemetryPanel.add(statusLabel, 0, 3, 2, 1);
        
        // GLOBAL MANIFEST (TABLE)
        VBox tableContainer = new VBox(10);
        tableContainer.getStyleClass().add("cyber-panel");
        tableContainer.setPadding(new Insets(15));
        
        Label tableTitle = new Label("GLOBAL MANIFEST");
        tableTitle.getStyleClass().add("panel-title");
        
        deviceList = FXCollections.observableArrayList();
        deviceTable = new TableView<>(deviceList);
        deviceTable.setPlaceholder(new Label("No Devices Registered"));
        
        TableColumn<DeviceLocation, String> idCol = new TableColumn<>("NODE_ID");
        idCol.setCellValueFactory(new PropertyValueFactory<>("deviceId"));
        
        TableColumn<DeviceLocation, Double> latCol = new TableColumn<>("LAT");
        latCol.setCellValueFactory(new PropertyValueFactory<>("latitude"));
        
        TableColumn<DeviceLocation, Double> lngCol = new TableColumn<>("LNG");
        lngCol.setCellValueFactory(new PropertyValueFactory<>("longitude"));
        
        TableColumn<DeviceLocation, String> timeCol = new TableColumn<>("TIMESTAMP");
        timeCol.setCellValueFactory(new PropertyValueFactory<>("timestamp"));
        
        deviceTable.getColumns().add(idCol);
        deviceTable.getColumns().add(latCol);
        deviceTable.getColumns().add(lngCol);
        deviceTable.getColumns().add(timeCol);
        deviceTable.setPrefHeight(300);
        
        Button mapsBtn = new Button("OPEN IN COMMAND MAP");
        mapsBtn.getStyleClass().add("button-outline");
        mapsBtn.setOnAction(e -> openInGoogleMaps());
        
        tableContainer.getChildren().addAll(tableTitle, deviceTable, mapsBtn);

        container.getChildren().addAll(loginPanel, tracePanel, telemetryPanel, tableContainer);
        sectionViews.put("Dashboard Overview", container);
        return container;
    }

    private VBox createSectionShell(String title) {
        VBox container = new VBox(18);
        container.setPadding(new Insets(24));
        container.setStyle("-fx-background-color: rgba(13, 18, 28, 0.94); -fx-border-color: rgba(0, 242, 255, 0.15); -fx-border-width: 1; -fx-border-radius: 8; -fx-background-radius: 8;");
        Label header = new Label(title);
        header.getStyleClass().add("panel-title");
        container.getChildren().add(header);
        return container;
    }

    private VBox createLiveMonitoringSection() {
        VBox container = createSectionShell("Live Device Monitoring");
        HBox metricRow = new HBox(14);
        metricRow.setAlignment(Pos.CENTER_LEFT);

        activeNodesMetricLabel = new Label("--");
        alertsMetricLabel = new Label("--");
        avgAccuracyMetricLabel = new Label("-- m");
        linkStatusMetricLabel = new Label("OFFLINE");

        metricRow.getChildren().addAll(
            createMetricCard("ACTIVE NODES", activeNodesMetricLabel, "#00ff88"),
            createMetricCard("ALERTS", alertsMetricLabel, "#ff4444"),
            createMetricCard("AVG ACCURACY", avgAccuracyMetricLabel, "#ffbb33"),
            createMetricCard("LINK STATUS", linkStatusMetricLabel, "#00f2ff")
        );

        VBox tableContainer = new VBox(10);
        tableContainer.setPadding(new Insets(14));
        tableContainer.setStyle("-fx-background-color: rgba(0,0,0,0.14); -fx-border-color: rgba(255,255,255,0.08); -fx-border-width: 1; -fx-border-radius: 6; -fx-background-radius: 6;");
        Label tableTitle = new Label("LIVE NODE MANIFEST");
        tableTitle.getStyleClass().add("panel-title");

        TableView<DeviceLocation> manifestTable = new TableView<>(deviceList);
        manifestTable.setPlaceholder(new Label("No Devices Registered"));
        manifestTable.setPrefHeight(300);
        manifestTable.getColumns().add(createColumn("NODE_ID", "deviceId", 160));
        manifestTable.getColumns().add(createColumn("LAT", "latitude", 100));
        manifestTable.getColumns().add(createColumn("LNG", "longitude", 100));
        manifestTable.getColumns().add(createColumn("TIMESTAMP", "timestamp", 220));
        manifestTable.setColumnResizePolicy(TableView.CONSTRAINED_RESIZE_POLICY);

        tableContainer.getChildren().addAll(tableTitle, manifestTable);
        container.getChildren().addAll(metricRow, tableContainer);

        totalDevicesLabel = new Label("Total Devices: --");
        activeConsentsLabel = new Label("Active Consents: --");
        recentAlertsLabel = new Label("Recent Alerts: --");
        totalDevicesLabel.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        activeConsentsLabel.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        recentAlertsLabel.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");

        HBox summaryRow = new HBox(18, totalDevicesLabel, activeConsentsLabel, recentAlertsLabel);
        summaryRow.setPadding(new Insets(10, 0, 0, 0));
        container.getChildren().add(summaryRow);
        sectionViews.put("Live Device Monitoring", container);
        return container;
    }

    private VBox createLiveMonitorPortalSection() {
        VBox container = createSectionShell("Live Monitor Portal");
        portalWebView = new WebView();
        VBox.setVgrow(portalWebView, Priority.ALWAYS);
        
        WebEngine webEngine = portalWebView.getEngine();
        webEngine.getLoadWorker().stateProperty().addListener((obs, oldVal, newVal) -> {
            if (newVal == javafx.concurrent.Worker.State.SUCCEEDED) {
                String token = tokenField.getText().trim();
                if (!token.isEmpty()) {
                    try {
                        webEngine.executeScript(
                            "localStorage.setItem('access_token', '" + token + "');" +
                            "jwtToken = '" + token + "';" +
                            "if (typeof showDashboard === 'function') { showDashboard(); }"
                        );
                    } catch (Exception ex) {
                        System.err.println("SSO token injection failed: " + ex.getMessage());
                    }
                }
            }
        });
        
        container.getChildren().add(portalWebView);
        sectionViews.put("Live Monitor Portal", container);
        return container;
    }

    private VBox createEnrollmentRequestsSection() {
        VBox container = createSectionShell("Device Enrollment Requests");
        Label detail = new Label("Pending operator request queue and secure link generation.");
        detail.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");

        enrollmentRequestsList = new ListView<>(enrollmentRequests);
        enrollmentRequestsList.setPlaceholder(new Label("No Tracking Requests Found"));
        enrollmentRequestsList.setPrefHeight(260);
        enrollmentRequests.clear();

        Button refreshBtn = new Button("Refresh Requests");
        refreshBtn.setOnAction(e -> refreshEnrollmentRequests());

        Button approveBtn = new Button("Approve Request");
        approveBtn.setOnAction(e -> updateEnrollmentRequestStatus("approved"));
        approveBtn.setStyle("-fx-base: #00ff88;");

        Button rejectBtn = new Button("Reject Request");
        rejectBtn.setOnAction(e -> updateEnrollmentRequestStatus("rejected"));
        rejectBtn.setStyle("-fx-base: #ff4444;");

        HBox actionRow = new HBox(10, refreshBtn, approveBtn, rejectBtn);
        container.getChildren().addAll(detail, enrollmentRequestsList, actionRow);
        sectionViews.put("Device Enrollment Requests", container);
        return container;
    }

    private void refreshEnrollmentRequests() {
        String token = tokenField.getText();
        if (token == null || token.isEmpty()) return;

        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/tracking-requests").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("requests");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String owner = node.path("owner_name").asText("<unknown>");
                            String tokenId = node.path("token").asText("");
                            String status = node.path("status").asText("");
                            items.add(String.format("%s — %s — %s", owner, tokenId, status));
                        }
                    }
                    Platform.runLater(() -> enrollmentRequests.setAll(items));
                }
            } catch (Exception ex) {
                // ignore errors for now
            }
        }).start();
    }

    private void updateEnrollmentRequestStatus(String status) {
        if (isUnauthenticated()) return;
        String selected = enrollmentRequestsList.getSelectionModel().getSelectedItem();
        if (selected == null || selected.isEmpty()) {
            showAlert("Request Action", "Select a request first.");
            return;
        }
        String[] parts = selected.split(" — ");
        if (parts.length < 3) return;
        String token = parts[1];

        new Thread(() -> {
            try {
                String body = String.format("{\"status\":\"%s\"}", status);
                HttpRequest req = requestBuilder(BACKEND_URL + "/tracking-requests/" + token + "/status")
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    Platform.runLater(() -> {
                        showAlert("Request Action", "Request " + status + " successfully.");
                        refreshEnrollmentRequests();
                        refreshDeviceRegistrations();
                    });
                } else {
                    Platform.runLater(() -> showAlert("Request Action", "Failed to update request."));
                }
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Request Action", "Error updating request."));
            }
        }).start();
    }

    private VBox createConsentManagementSection() {
        VBox container = createSectionShell("Consent Management");
        Label summary = new Label("Revoke or audit active consent agreements and view authorization history.");
        summary.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        consentListView = new ListView<>(consentItems);
        consentListView.setPlaceholder(new Label("No Devices Registered"));
        consentListView.setPrefHeight(260);

        Button refreshBtn = new Button("Refresh Consents");
        refreshBtn.setOnAction(e -> refreshConsentList());

        Button revokeBtn = new Button("WITHDRAW SELECTED CONSENT");
        revokeBtn.setMaxWidth(Double.MAX_VALUE);
        revokeBtn.getStyleClass().add("button-outline");
        revokeBtn.setOnAction(e -> revokeSelectedConsent());

        container.getChildren().addAll(summary, consentListView, refreshBtn, revokeBtn);
        sectionViews.put("Consent Management", container);
        return container;
    }

    private void refreshConsentList() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/device-registrations").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("registrations");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String did = node.path("device_id").asText("<id>");
                            String owner = node.path("owner_name").asText("<owner>");
                            String ts = node.path("registered_at").asText("");
                            items.add(String.format("%s — %s — %s", did, owner, ts));
                        }
                    }
                    Platform.runLater(() -> {
                        consentItems.setAll(items);
                        refreshReports();
                    });
                }
            } catch (Exception e) {}
        }).start();
    }

    private VBox createGeofenceAdministrationSection() {
        VBox container = createSectionShell("Geofence Administration");
        Label text = new Label("Deploy geo-zones, review boundary integrity, and monitor enforcement.");
        text.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");

        HBox deviceRow = new HBox(10);
        deviceRow.setAlignment(Pos.CENTER_LEFT);
        Label deviceLabel = new Label("DEVICE ID:");
        deviceLabel.setPrefWidth(90);
        geofenceDeviceField = new TextField();
        geofenceDeviceField.setPromptText("Enter or choose device id");
        geofenceDeviceField.setPrefWidth(280);
        deviceRow.getChildren().addAll(deviceLabel, geofenceDeviceField);

        HBox coordRow = new HBox(10);
        coordRow.setAlignment(Pos.CENTER_LEFT);
        geofenceLatField = new TextField();
        geofenceLatField.setPromptText("Center latitude");
        geofenceLatField.setPrefWidth(150);
        geofenceLngField = new TextField();
        geofenceLngField.setPromptText("Center longitude");
        geofenceLngField.setPrefWidth(150);
        geofenceRadiusField = new TextField();
        geofenceRadiusField.setPromptText("Radius meters");
        geofenceRadiusField.setPrefWidth(130);
        coordRow.getChildren().addAll(geofenceLatField, geofenceLngField, geofenceRadiusField);

        HBox actionRow = new HBox(10);
        Button loadFence = new Button("LOAD ZONE");
        loadFence.setOnAction(e -> loadGeofence());
        Button setFence = new Button("SET GEOFENCE");
        setFence.setOnAction(e -> setGeofence());
        actionRow.getChildren().addAll(loadFence, setFence);

        container.getChildren().addAll(text, deviceRow, coordRow, actionRow);
        sectionViews.put("Geofence Administration", container);
        return container;
    }

    private VBox createAlertCenterSection() {
        VBox container = createSectionShell("Alert Center");
        alertListView = new ListView<>(alertItems);
        alertListView.setPrefHeight(320);
        Button refreshBtn = new Button("Refresh Alerts");
        refreshBtn.setOnAction(e -> refreshAlerts());
        container.getChildren().addAll(alertListView, refreshBtn);
        sectionViews.put("Alert Center", container);
        return container;
    }

    private VBox createThreatIntelSection() {
        VBox container = createSectionShell("Threat Intelligence");
        Label insights = new Label("Analyze threat pulses, verify anomaly clusters, and tune sensory heuristics.");
        insights.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        threatListView = new ListView<>(threatItems);
        threatListView.setPrefHeight(280);
        Button refreshBtn = new Button("Refresh Threat Feed");
        refreshBtn.setOnAction(e -> refreshThreatIntel());
        container.getChildren().addAll(insights, threatListView, refreshBtn);
        sectionViews.put("Threat Intelligence", container);
        return container;
    }

    private VBox createAuditLogsSection() {
        VBox container = createSectionShell("Audit Logs");
        auditListView = new ListView<>(auditItems);
        auditListView.setPrefHeight(320);
        Button refreshBtn = new Button("Refresh Audit Logs");
        refreshBtn.setOnAction(e -> refreshAuditLogs());
        container.getChildren().addAll(auditListView, refreshBtn);
        sectionViews.put("Audit Logs", container);
        return container;
    }

    private void refreshAuditLogs() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/vault/logs").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("logs");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String ts = node.path("created_at").asText("");
                            JsonNode dataNode = node.path("data");
                            String ev = dataNode.path("event").asText("");
                            String who = node.path("owner").asText("");
                            items.add(String.format("%s — %s — %s", ts, ev, who));
                        }
                    }
                    Platform.runLater(() -> {
                        if (items.isEmpty()) {
                            items.add("No audit events recorded.");
                        }
                        auditItems.setAll(items);
                    });
                }
            } catch (Exception e) {
                Platform.runLater(() -> {
                    auditItems.setAll(FXCollections.observableArrayList("No audit events recorded."));
                });
            }
        }).start();
    }

    private VBox createDeviceRegistrySection() {
        VBox container = createSectionShell("Device Registry");
        registryListView = new ListView<>(registryItems);
        registryListView.setPrefHeight(320);
        Button refreshBtn = new Button("Refresh Registry");
        refreshBtn.setOnAction(e -> refreshDeviceRegistrations());
        container.getChildren().addAll(registryListView, refreshBtn);
        sectionViews.put("Device Registry", container);
        return container;
    }

    private VBox createReportsSection() {
        VBox container = createSectionShell("Reports & Analytics");
        Label summary = new Label("Generate compliance reports, export consent timelines, and review operational KPIs.");
        summary.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        Label reportText = new Label("Current dashboard counts and consent metrics are available in the overview.");
        reportText.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        Button refreshBtn = new Button("Refresh Dashboard Summary");
        refreshBtn.setOnAction(e -> refreshReports());
        container.getChildren().addAll(summary, reportText, refreshBtn);
        sectionViews.put("Reports & Analytics", container);
        return container;
    }

    private VBox createOperatorManagementSection() {
        VBox container = createSectionShell("Operator Management");
        operatorsListView = new ListView<>(operatorItems);
        operatorsListView.setPrefHeight(320);
        Button refreshBtn = new Button("Refresh Operators");
        refreshBtn.setOnAction(e -> refreshOperators());
        Button createBtn = new Button("Create Operator");
        createBtn.setOnAction(e -> promptCreateOperator());
        HBox buttonRow = new HBox(10, refreshBtn, createBtn);
        container.getChildren().addAll(operatorsListView, buttonRow);
        sectionViews.put("Operator Management", container);
        return container;
    }

    private void refreshOperators() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/operators").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("operators");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String uname = node.path("username").asText("");
                            String created = node.path("created_at").asText("");
                            items.add(String.format("%s — %s", uname, created));
                        }
                    }
                    Platform.runLater(() -> operatorItems.setAll(items));
                }
            } catch (Exception e) {}
        }).start();
    }

    private void refreshDeviceRegistrations() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/device-registrations").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("registrations");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String did = node.path("device_id").asText("<id>");
                            String owner = node.path("owner_name").asText("<owner>");
                            String status = node.path("tracking_status").asText("<status>");
                            items.add(String.format("%s — %s — %s", did, owner, status));
                        }
                    }
                    Platform.runLater(() -> registryItems.setAll(items));
                }
            } catch (Exception e) {}
        }).start();
    }

    private void refreshAlerts() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/alerts").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("alerts");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    int count = 0;
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String dev = node.path("device_id").asText("<id>");
                            String type = node.path("type").asText("<type>");
                            String message = node.path("message").asText(node.path("type").asText(""));
                            String ts = node.path("created_at").asText("");
                            items.add(String.format("%s — %s — %s — %s", ts, dev, type, message));
                            count++;
                        }
                    }
                    final int finalCount = count;
                    Platform.runLater(() -> {
                        alertItems.setAll(items);
                        if (recentAlertsLabel != null) {
                            recentAlertsLabel.setText("Recent Alerts: " + finalCount);
                        }
                        refreshReports();
                    });
                }
            } catch (Exception e) {}
        }).start();
    }

    private void refreshThreatIntel() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/vault/threats").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode arr = objectMapper.readTree(res.body()).path("threats");
                    ObservableList<String> items = FXCollections.observableArrayList();
                    if (arr.isArray()) {
                        for (JsonNode node : arr) {
                            String ts = node.path("created_at").asText("");
                            String data = node.path("data").toString();
                            items.add(String.format("%s — %s", ts, data));
                        }
                    }
                    Platform.runLater(() -> threatItems.setAll(items));
                }
            } catch (Exception e) {}
        }).start();
    }

    private void loadSystemHealth() {
        new Thread(() -> {
            try {
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(BACKEND_URL + "/health"))
                        .GET()
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode json = objectMapper.readTree(res.body());
                    Platform.runLater(() -> {
                        systemHealthLabel.setText(String.format("API Health: %s — %s", json.path("status").asText("unknown"), json.path("timestamp").asText("")));
                    });
                } else {
                    Platform.runLater(() -> systemHealthLabel.setText("API Health: unavailable"));
                }
            } catch (Exception e) {
                Platform.runLater(() -> systemHealthLabel.setText("API Health: offline"));
            }
        }).start();
    }

    private void revokeSelectedConsent() {
        if (isUnauthenticated()) return;
        String selected = consentListView.getSelectionModel().getSelectedItem();
        if (selected == null || selected.isEmpty()) {
            showAlert("Revoke Consent", "Select a consent record first.");
            return;
        }
        String deviceId = selected.split(" — ")[0];
        new Thread(() -> {
            try {
                String body = String.format("{\"device_id\":\"%s\"}", deviceId);
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(BACKEND_URL + "/consent/revoke"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    Platform.runLater(() -> {
                        showAlert("Revoke Consent", "Consent withdrawn for device " + deviceId);
                        refreshConsentList();
                        refreshDeviceRegistrations();
                    });
                } else {
                    Platform.runLater(() -> showAlert("Revoke Consent", "Failed to withdraw consent."));
                }
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Revoke Consent", "Error revoking consent."));
            }
        }).start();
    }

    private void setGeofence() {
        if (isUnauthenticated()) return;
        String deviceId = geofenceDeviceField.getText().trim();
        String lat = geofenceLatField.getText().trim();
        String lng = geofenceLngField.getText().trim();
        String radius = geofenceRadiusField.getText().trim();
        if (deviceId.isEmpty() || lat.isEmpty() || lng.isEmpty() || radius.isEmpty()) {
            showAlert("Geofence", "All geofence fields are required.");
            return;
        }
        new Thread(() -> {
            try {
                String body = String.format("{\"device_id\":\"%s\",\"center_lat\":%s,\"center_lng\":%s,\"radius_meters\":%s}", deviceId, lat, lng, radius);
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(BACKEND_URL + "/geofence"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    Platform.runLater(() -> showAlert("Geofence", "Geofence successfully established."));
                } else {
                    Platform.runLater(() -> showAlert("Geofence", "Failed to establish geofence."));
                }
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Geofence", "Error calling geofence service."));
            }
        }).start();
    }

    private void loadGeofence() {
        if (isUnauthenticated()) return;
        String deviceId = geofenceDeviceField.getText().trim();
        if (deviceId.isEmpty()) {
            showAlert("Geofence", "Enter a device ID to load the zone.");
            return;
        }
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/geofence/" + deviceId).GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode json = objectMapper.readTree(res.body());
                    Platform.runLater(() -> {
                        geofenceLatField.setText(json.path("center_lat").asText(""));
                        geofenceLngField.setText(json.path("center_lng").asText(""));
                        geofenceRadiusField.setText(json.path("radius_meters").asText(""));
                        showAlert("Geofence", "Loaded geofence for " + deviceId);
                    });
                } else {
                    Platform.runLater(() -> showAlert("Geofence", "No Active Geofences"));
                }
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Geofence", "Error loading geofence."));
            }
        }).start();
    }

    private void promptCreateOperator() {
        Platform.runLater(() -> {
            TextInputDialog dialog = new TextInputDialog();
            dialog.setTitle("Provision Operator");
            dialog.setHeaderText("Create a new operator account");
            dialog.setContentText("Enter username,email or alias:");
            dialog.showAndWait().ifPresent(username -> {
                if (username.trim().isEmpty()) {
                    showAlert("Operator Provisioning", "Username is required.");
                } else {
                    TextInputDialog passwordDialog = new TextInputDialog();
                    passwordDialog.setTitle("Operator Password");
                    passwordDialog.setHeaderText("Create a secure password");
                    passwordDialog.setContentText("Password:");
                    passwordDialog.showAndWait().ifPresent(password -> {
                        if (password.trim().isEmpty()) {
                            showAlert("Operator Provisioning", "Password is required.");
                        } else {
                            createOperator(username.trim(), password.trim());
                        }
                    });
                }
            });
        });
    }

    private void createOperator(String username, String password) {
        new Thread(() -> {
            try {
                String body = String.format("{\"username\":\"%s\",\"password\":\"%s\"}", username, password);
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(BACKEND_URL + "/auth/register"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 201) {
                    Platform.runLater(() -> {
                        showAlert("Operator Provisioning", "Operator created successfully.");
                        refreshOperators();
                    });
                } else {
                    String bodyText = res.body();
                    Platform.runLater(() -> showAlert("Operator Provisioning", "Failed to create operator: " + bodyText));
                }
            } catch (Exception e) {
                Platform.runLater(() -> showAlert("Operator Provisioning", "Error creating operator."));
            }
        }).start();
    }

    private void refreshReports() {
        if (tokenField.getText().trim().isEmpty()) return;
        new Thread(() -> {
            try {
                HttpRequest req = requestBuilder(BACKEND_URL + "/dashboard/summary").GET().build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                if (res.statusCode() == 200) {
                    JsonNode json = objectMapper.readTree(res.body());
                    int activeDevices = json.path("activeDevices").asInt(0);
                    int trackingRequests = json.path("trackingRequests").asInt(0);
                    int alerts = json.path("alerts").asInt(0);
                    Platform.runLater(() -> {
                        if (totalDevicesLabel != null) {
                            totalDevicesLabel.setText("Active Devices: " + activeDevices);
                        }
                        if (activeConsentsLabel != null) {
                            activeConsentsLabel.setText("Tracking Requests: " + trackingRequests);
                        }
                        if (recentAlertsLabel != null) {
                            recentAlertsLabel.setText("Alerts: " + alerts);
                        }
                        if (activeNodesMetricLabel != null) {
                            activeNodesMetricLabel.setText(String.valueOf(activeDevices));
                        }
                        if (alertsMetricLabel != null) {
                            alertsMetricLabel.setText(String.valueOf(alerts));
                        }
                    });
                }
            } catch (Exception e) {
                System.err.println("Dashboard summary refresh failed: " + e.getMessage());
            }
        }).start();
    }

    private VBox createHealthMonitoringSection() {
        VBox container = createSectionShell("System Health");
        HBox healthRow = new HBox(12);
        healthRow.getChildren().addAll(
            createMetricCard("CPU LOAD", new Label("12%"), "#00ff88"),
            createMetricCard("MEMORY", new Label("2.8GB"), "#ffbb33"),
            createMetricCard("UPTIME", new Label("4h 21m"), "#00f2ff")
        );
        container.getChildren().addAll(healthRow);
        sectionViews.put("System Health", container);
        return container;
    }

    private VBox createSettingsSection() {
        VBox container = createSectionShell("Settings");
        Label summary = new Label("Configure network bridges, gateway ports, and consent lifecycle policies.");
        summary.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        systemHealthLabel = new Label("API Health: unknown");
        systemHealthLabel.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 12px;");
        Button healthBtn = new Button("Run Health Check");
        healthBtn.setOnAction(e -> loadSystemHealth());
        container.getChildren().addAll(summary, systemHealthLabel, healthBtn);
        sectionViews.put("Settings", container);
        return container;
    }

    private VBox createMetricCard(String label, Label valLabel, String accent) {
        VBox card = new VBox(6);
        card.setPadding(new Insets(14));
        card.setStyle("-fx-background-color: rgba(0,0,0,0.18); -fx-border-color: " + accent + "; -fx-border-width: 1; -fx-border-radius: 8; -fx-background-radius: 8;");
        Label title = new Label(label);
        title.setStyle("-fx-text-fill: #9acddf; -fx-font-size: 11px;");
        valLabel.setStyle("-fx-text-fill: " + accent + "; -fx-font-size: 22px; -fx-font-weight: bold;");
        card.getChildren().addAll(title, valLabel);
        return card;
    }

    private <T> TableColumn<DeviceLocation, T> createColumn(String title, String property, int minWidth) {
        TableColumn<DeviceLocation, T> col = new TableColumn<>(title);
        col.setCellValueFactory(new PropertyValueFactory<>(property));
        col.setMinWidth(minWidth);
        return col;
    }

    private void loginAndFetchToken() {
        String username = usernameField.getText().trim();
        String password = passwordField.getText().trim();
        if (username.isEmpty() || password.isEmpty()) {
            Platform.runLater(() -> {
                authStatusLabel.setText("ERR: USERNAME_AND_PASSWORD_REQUIRED");
                authStatusLabel.setStyle("-fx-text-fill: #ff5f5f; -fx-font-size: 10px;");
            });
            return;
        }
        Platform.runLater(() -> {
            authStatusLabel.setText("AUTHENTICATING...");
            authStatusLabel.setStyle("-fx-text-fill: #00f2ff; -fx-font-size: 10px;");
        });
        new Thread(() -> {
            try {
                String body = "{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}";
                HttpRequest req = HttpRequest.newBuilder()
                        .uri(URI.create(BACKEND_URL + "/login"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body))
                        .build();
                HttpResponse<String> res = httpClient.send(req, HttpResponse.BodyHandlers.ofString());
                JsonNode json = objectMapper.readTree(res.body());

                if (res.statusCode() == 200) {
                    String token = json.path("access_token").asText();
                    Platform.runLater(() -> {
                        tokenField.setText(token);
                        authStatusLabel.setText("ACCESS_GRANTED — " + username.toUpperCase());
                        authStatusLabel.setStyle("-fx-text-fill: #00ff9d; -fx-font-size: 10px;");
                    });
                    // Auto-populate device list
                    refreshAllDevices();
                    refreshEnrollmentRequests();
                    refreshConsentList();
                    refreshAuditLogs();
                    refreshOperators();
                    refreshDeviceRegistrations();
                    refreshAlerts();
                    refreshThreatIntel();
                    loadSystemHealth();
                } else {
                    String err = json.path("error").asText("INVALID_CREDENTIALS");
                    Platform.runLater(() -> {
                        authStatusLabel.setText("DENIED: " + err.toUpperCase());
                        authStatusLabel.setStyle("-fx-text-fill: #ff5f5f; -fx-font-size: 10px;");
                    });
                }
            } catch (Exception e) {
                Platform.runLater(() -> {
                    authStatusLabel.setText("ERR: BACKEND_OFFLINE");
                    authStatusLabel.setStyle("-fx-text-fill: #ff5f5f; -fx-font-size: 10px;");
                });
            }
        }).start();
    }

    private void refreshAllDevices() {
        if (isUnauthenticated()) return;
        new Thread(() -> {
            try {
                HttpRequest request = requestBuilder(BACKEND_URL + "/devices").GET().build();
                HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

                if (response.statusCode() == 200) {
                    JsonNode root = objectMapper.readTree(response.body());
                    JsonNode deviceArray = root.path("devices");
                    ObservableList<DeviceLocation> newItems = FXCollections.observableArrayList();
                    ObservableList<String> newIds = FXCollections.observableArrayList();

                    double totalAcc = 0;
                    int accCount = 0;
                    if (deviceArray.isArray()) {
                        for (JsonNode node : deviceArray) {
                            String id = node.path("device_id").asText();
                            double lat = node.path("latitude").asDouble();
                            double lng = node.path("longitude").asDouble();
                            double acc = node.path("accuracy").asDouble();
                            String ts  = node.path("timestamp").asText();
                            newItems.add(new DeviceLocation(id, lat, lng, acc, ts));
                            newIds.add(id);
                            if (acc > 0) {
                                totalAcc += acc;
                                accCount++;
                            }
                        }
                    }
                    final double avgAcc = accCount > 0 ? totalAcc / accCount : 0;

                    Platform.runLater(() -> {
                        deviceList.setAll(newItems);
                        registeredIdsList.setAll(newIds);
                        // Populate the combo box
                        deviceComboBox.getItems().setAll(newIds);
                        statusLabel.setText("STATUS: Manifest Updated");
                        if (avgAccuracyMetricLabel != null) {
                            avgAccuracyMetricLabel.setText(String.format("%.1f m", avgAcc));
                        }
                        refreshReports();
                    });
                } else if (response.statusCode() == 401) {
                    Platform.runLater(() -> showAlert("Auth Error", "Session expired or invalid token."));
                }
            } catch (Exception e) {
                System.err.println("Refresh failed: " + e.getMessage());
            }
        }).start();
    }

    private void fetchDeviceLocation() {
        if (isUnauthenticated()) return;
        String id = deviceIdField.getText().trim();
        if (id.isEmpty()) return;
        
        new Thread(() -> {
            try {
                HttpRequest request = requestBuilder(BACKEND_URL + "/location/" + id).GET().build();
                HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
                
                if (response.statusCode() == 200) {
                    JsonNode node = objectMapper.readTree(response.body());
                    Platform.runLater(() -> {
                        if (node.path("latitude").isNull() || node.path("latitude").isMissingNode() || (node.path("latitude").asDouble() == 0.0 && node.path("longitude").asDouble() == 0.0)) {
                            latitudeLabel.setText("LATITUDE: No Location Updates Available");
                            longitudeLabel.setText("LONGITUDE: No Location Updates Available");
                            accuracyLabel.setText("ACCURACY: --");
                            timestampLabel.setText("SYNC: --");
                            statusLabel.setText("STATUS: Awaiting GPS Telemetry");
                        } else {
                            latitudeLabel.setText("LATITUDE: " + node.path("latitude").asDouble());
                            longitudeLabel.setText("LONGITUDE: " + node.path("longitude").asDouble());
                            accuracyLabel.setText("ACCURACY: " + node.path("accuracy").asDouble() + "M");
                            timestampLabel.setText("SYNC: " + node.path("timestamp").asText());
                            statusLabel.setText("STATUS: Point Lock Acquired");
                        }
                        currentDeviceId = id;
                    });
                }
            } catch (Exception e) {}
        }).start();
    }

    private void connectWebSocket() {
        if (isUnauthenticated()) return;
        String token = tokenField.getText().trim();

        String wsUrl = BACKEND_URL.replace("http", "ws") + "/ws?token=" + token;
        httpClient.newWebSocketBuilder()
                .buildAsync(URI.create(wsUrl), new WebSocket.Listener() {
                    StringBuilder buffer = new StringBuilder();

                    @Override
                    public void onOpen(WebSocket ws) {
                        AegisTrackDashboard.this.webSocket = ws;
                        ws.request(1);
                        Platform.runLater(() -> {
                            connectionStatusLabel.setText("WS: LINK_ACTIVE");
                            if (linkStatusMetricLabel != null) linkStatusMetricLabel.setText("ONLINE");
                        });
                    }

                    @Override
                    public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
                        Platform.runLater(() -> {
                            connectionStatusLabel.setText("WS: DISCONNECTED");
                            if (linkStatusMetricLabel != null) linkStatusMetricLabel.setText("OFFLINE");
                        });
                        return null;
                    }

                    @Override
                    public void onError(WebSocket ws, Throwable error) {
                        Platform.runLater(() -> {
                            connectionStatusLabel.setText("WS: ERROR");
                            if (linkStatusMetricLabel != null) linkStatusMetricLabel.setText("ERROR");
                        });
                    }

                    @Override
                    public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                        buffer.append(data);
                        if (last) {
                            handleWS(buffer.toString());
                            buffer.setLength(0);
                        }
                        ws.request(1);
                        return null;
                    }
                });
    }

    private boolean isUnauthenticated() {
        String token = tokenField.getText().trim();
        if (token.isEmpty()) {
            showAlert("DENIED", "AUTHENTICATION_REQUIRED. Enter username + password and click AUTHENTICATE first.");
            return true;
        }
        return false;
    }

    private void handleWS(String text) {
        try {
            JsonNode msg = objectMapper.readTree(text);
            if ("location_updated".equals(msg.path("event").asText())) {
                JsonNode p = msg.path("payload");
                if (p.path("device_id").asText().equals(currentDeviceId)) {
                    Platform.runLater(() -> {
                        latitudeLabel.setText("LATITUDE: " + p.path("latitude").asDouble());
                        longitudeLabel.setText("LONGITUDE: " + p.path("longitude").asDouble());
                        accuracyLabel.setText("ACCURACY: " + p.path("accuracy").asDouble() + "M");
                        timestampLabel.setText("SYNC: " + p.path("timestamp").asText());
                        statusLabel.setText("STATUS: LIVE_UPDATE");
                        statusLabel.getStyleClass().add("status-live");
                    });
                }
            }
        } catch (Exception e) {}
    }

    private void openInGoogleMaps() {
        DeviceLocation sel = deviceTable.getSelectionModel().getSelectedItem();
        if (sel != null) {
            String url = String.format("https://www.google.com/maps/search/?api=1&query=%f,%f", sel.getLatitude(), sel.getLongitude());
            try {
                java.awt.Desktop.getDesktop().browse(java.net.URI.create(url));
            } catch (Exception e) {}
        }
    }

    private HttpRequest.Builder requestBuilder(String url) {
        HttpRequest.Builder b = HttpRequest.newBuilder().uri(URI.create(url));
        String t = tokenField.getText().trim();
        if (!t.isEmpty()) b.header("Authorization", "Bearer " + t);
        return b;
    }

    private void showAlert(String t, String m) {
        Platform.runLater(() -> {
            Alert a = new Alert(Alert.AlertType.INFORMATION);
            a.setTitle(t);
            a.setHeaderText(null);
            a.setContentText(m);
            a.showAndWait();
        });
    }

    public static class DeviceLocation {
        private final String deviceId;
        private final double latitude;
        private final double longitude;
        private final double accuracy;
        private final String timestamp;

        public DeviceLocation(String id, double lat, double lng, double acc, String ts) {
            this.deviceId = id; this.latitude = lat; this.longitude = lng;
            this.accuracy = acc; this.timestamp = ts;
        }
        public String getDeviceId() { return deviceId; }
        public double getLatitude() { return latitude; }
        public double getLongitude() { return longitude; }
        public double getAccuracy() { return accuracy; }
        public String getTimestamp() { return timestamp; }
    }
}
