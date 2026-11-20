package com.erp.rfid.ui;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.RadioGroup;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.erp.rfid.R;
import com.erp.rfid.net.Prefs;

/** 主页：功能入口——盘点 / 条码迁移。 */
public class HomeActivity extends AppCompatActivity {

    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        setContentView(R.layout.activity_home);
        Prefs prefs = new Prefs(this);

        TextView tvWho = findViewById(R.id.tv_who);
        tvWho.setText("设备：" + (prefs.name().isEmpty() ? prefs.username() : prefs.name()));

        RadioGroup rgPower = findViewById(R.id.rg_power);
        int cur = prefs.scanPower();
        if (cur == Prefs.POWER_LOW) rgPower.check(R.id.rb_power_low);
        else if (cur == Prefs.POWER_MID) rgPower.check(R.id.rb_power_mid);
        else if (cur == Prefs.POWER_MIDHIGH) rgPower.check(R.id.rb_power_midhigh);
        else rgPower.check(R.id.rb_power_high);
        rgPower.setOnCheckedChangeListener((group, id) -> {
            if (id == R.id.rb_power_low) prefs.setScanPower(Prefs.POWER_LOW);
            else if (id == R.id.rb_power_mid) prefs.setScanPower(Prefs.POWER_MID);
            else if (id == R.id.rb_power_midhigh) prefs.setScanPower(Prefs.POWER_MIDHIGH);
            else prefs.setScanPower(Prefs.POWER_HIGH);
        });

        Button btnStock = findViewById(R.id.btn_stock);
        Button btnMigrate = findViewById(R.id.btn_migrate);
        Button btnLogout = findViewById(R.id.btn_logout);

        btnStock.setOnClickListener(v -> startActivity(new Intent(this, StocktakeActivity.class)));
        btnMigrate.setOnClickListener(v -> startActivity(new Intent(this, MigrateActivity.class)));
        btnLogout.setOnClickListener(v -> {
            prefs.clearToken();
            startActivity(new Intent(this, LoginActivity.class));
            finish();
        });
    }
}
