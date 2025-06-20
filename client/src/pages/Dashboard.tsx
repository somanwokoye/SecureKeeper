import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock, ShieldCheck, AlertTriangle } from "lucide-react";
import StatsCard from "@/components/dashboard/StatsCard";
import RecentActivity from "@/components/dashboard/RecentActivity";
import PasswordHealth from "@/components/dashboard/PasswordHealth";
import SecurityTips from "@/components/security/SecurityTips";
import PremiumFeatures from "@/components/security/PremiumFeatures";
import PasswordGenerator from "@/components/common/PasswordGenerator";

const Dashboard: React.FC = () => {
  // Fetch current user
  const { data: userData, isLoading: userLoading } = useQuery({
    queryKey: ['/api/auth/me'],
  });
  
  // Fetch password stats
  const { data: passwordStats, isLoading: statsLoading } = useQuery({
    queryKey: ['/api/password-stats'],
  });
  
  // Fetch security alerts
  const { data: securityAlerts, isLoading: alertsLoading } = useQuery({
    queryKey: ['/api/security-alerts'],
  });

  // Get user's first name
  const firstName = userData?.user?.name?.split(' ')[0] || userData?.user?.username || 'there';
  
  // Count unresolved alerts
  const unresolvedAlerts = securityAlerts?.filter((alert: any) => !alert.isResolved)?.length || 0;
  
  // Get password health percentage
  const passwordHealthPercentage = passwordStats ? 
    Math.max(0, Math.min(100, Math.round(
      (passwordStats.strong / Math.max(1, passwordStats.total)) * 100
    ))) : 0;

  return (
    <div>
      {/* Welcome Section */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Welcome back, {firstName}!</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-1">
          {unresolvedAlerts > 0 
            ? `Your password security needs attention. You have ${unresolvedAlerts} item${unresolvedAlerts !== 1 ? 's' : ''} that need${unresolvedAlerts === 1 ? 's' : ''} attention.`
            : "Your password security is in good shape. No issues detected."
          }
        </p>
      </div>
      
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <StatsCard
          title="Total Passwords"
          value={statsLoading ? "..." : passwordStats?.total || 0}
          icon={<Lock className="h-6 w-6" />}
          iconBgColor="bg-primary-100 dark:bg-primary-900/20"
          iconColor="text-primary"
          subText={statsLoading ? "" : `${passwordStats?.total - passwordStats?.strong || 0} need attention`}
        />
        
        <StatsCard
          title="Password Health"
          value={statsLoading ? "..." : passwordHealthPercentage}
          icon={<ShieldCheck className="h-6 w-6" />}
          iconBgColor="bg-secondary-100 dark:bg-secondary-900/20"
          iconColor="text-secondary-600 dark:text-secondary-400"
          progressValue={passwordHealthPercentage}
          progressColor="bg-secondary-500"
          subText={statsLoading ? "" : `${passwordStats?.weak || 0} weak passwords`}
        />
        
        <StatsCard
          title="Security Alerts"
          value={alertsLoading ? "..." : unresolvedAlerts}
          icon={<AlertTriangle className="h-6 w-6" />}
          iconBgColor="bg-warning-100 dark:bg-warning-900/20"
          iconColor="text-warning-500 dark:text-warning-400"
          subText={alertsLoading 
            ? "" 
            : unresolvedAlerts > 0 
              ? `${unresolvedAlerts} issue${unresolvedAlerts !== 1 ? 's' : ''} detected`
              : "No security issues detected"
          }
        />
      </div>
      
      {/* Recent Activity and Password Generator */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mb-8">
        <RecentActivity />
        <PasswordGenerator title="Quick Password Generator" />
      </div>
      
      {/* Password Health Section */}
      <div className="mb-8">
        <PasswordHealth />
      </div>
      
      {/* Bottom Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <PremiumFeatures />
        <SecurityTips />
      </div>
    </div>
  );
};

export default Dashboard;
