import React from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../authConfig';

interface LoginProps {
  onBypass?: () => void;
}

export const Login: React.FC<LoginProps> = ({ onBypass }) => {
  const { instance } = useMsal();

  return (
    <div className="min-h-screen flex items-center justify-center bg-mauve-2 px-4">
      <div className="bg-white border border-mauve-6 rounded-lg w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <img src="/mac_logo.png" className="w-12 h-12 mx-auto mb-4 object-contain" />
          <h1 className="text-[18px] font-semibold text-mauve-12 tracking-tight">M2M Assistant</h1>
          <p className="text-[13px] text-mauve-11 mt-1">Sign in with your MAC Products account</p>
        </div>
        <button
          onClick={() => instance.loginRedirect(loginRequest)}
          className="w-full bg-mac-navy hover:bg-mac-blue text-white font-medium text-[13px] py-2.5 px-4 rounded-md transition-colors flex items-center justify-center gap-2.5"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 21 21">
            <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
            <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
          </svg>
          Sign in with Microsoft
        </button>
        {onBypass && (
          <button
            onClick={onBypass}
            className="w-full mt-3 py-2 px-4 rounded-md border border-dashed border-mauve-6 text-[11px] text-mauve-11 hover:text-mauve-12 transition-colors"
          >
            Dev bypass · skip SSO
          </button>
        )}
        <div className="mt-8 pt-5 border-t border-mauve-4 text-center">
          <p className="text-[10px] text-mauve-9 tracking-tight">
            MAC Products internal system
          </p>
        </div>
      </div>
    </div>
  );
};
