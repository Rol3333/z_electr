sap.ui.define([
    "sap/ui/core/UIComponent",
    "zelectr/model/models"
], (UIComponent, models) => {
    "use strict";

    return UIComponent.extend("zelectr.Component", {
        metadata: {
            manifest: "json",
            interfaces: [
                "sap.ui.core.IAsyncContentCreation"
            ]
        },

        init() {
            // call the base component's init function
            UIComponent.prototype.init.apply(this, arguments);

            // set the device model
            this.setModel(models.createDeviceModel(), "device");

            // enable routing
            this.getRouter().initialize();

            // FLP tile support: each report can be launched directly from its
            // own Fiori Launchpad tile via intent startup parameters, without
            // visiting a home page first. Tile intent mapping:
            //   report=formulaTest   -> #formula-test
            //   report=currentMonth  -> #current-month
            //   report=yearReport    -> #year-report (optionally &pos=<position>)
            // Example tile intent: Zelectr-display?report=yearReport&pos=bE24X
            var oComponentData = this.getComponentData() || {};
            var mStartup = oComponentData.startupParameters || {};
            var sReport = mStartup.report && mStartup.report[0];
            var sPos = mStartup.pos && mStartup.pos[0];
            var oRouter = this.getRouter();

            if (sReport === "currentMonth") {
                oRouter.navTo("RouteCurrentMonth", {}, true);
            } else if (sReport === "yearReport") {
                if (sPos) {
                    oRouter.navTo("RouteYearReportPos", { pos: sPos }, true);
                } else {
                    oRouter.navTo("RouteYearReport", {}, true);
                }
            } else if (sReport === "formulaTest") {
                oRouter.navTo("RouteFormulaTest", {}, true);
            }
        }
    });
});
