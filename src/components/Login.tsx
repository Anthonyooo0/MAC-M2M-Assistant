import React from 'react';
import { useMsal } from '@azure/msal-react';
import { loginRequest } from '../authConfig';

interface LoginProps {
  onBypass?: () => void;
}

export const Login: React.FC<LoginProps> = ({ onBypass }) => {
  const { instance } = useMsal();

  return (
    <div className="min-h-screen flex items-center justify-center bg-mac-light px-4">
      <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-slate-200">
        <div className="text-center mb-8">
          <img src="/mac_logo.png" className="w-16 h-16 mx-auto mb-4 object-contain" />
          <h1 className="text-2xl font-bold text-slate-800">M2M Assistant</h1>
          <p className="text-slate-500 text-sm mt-1">Sign in with your MAC Products account</p>
        </div>
        <button
          onClick={() => instance.loginRedirect(loginRequest)}
          className="w-full bg-[#2F2F2F] hover:bg-[#1F1F1F] text-white font-semibold py-3 px-4 rounded-xl transition-all shadow-lg flex items-center justify-center gap-3"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 21 21">
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
            className="w-full mt-3 py-3 px-4 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 text-sm font-medium transition-all"
          >
            Dev Bypass (Skip SSO)
          </button>
        )}
        <div className="mt-8 pt-6 border-t border-slate-100 text-center">
          <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold">
            MAC PRODUCTS INTERNAL SYSTEM
          </p>
        </div>
      </div>
    </div>
  );
};
