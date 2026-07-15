<template>
  <main class="main-content full-height fh-custom">
    <div :class="['card', (access || accessData) ? '':'hide']">
      <div class="card-header"><h5>گردش حساب</h5></div>
      <div class="card-header p-0">
        <div class="row p-l-r-25">
          <div class="col-lg-6 col-md-12">
            <div :class="['form-group', access?'':'hide']">
              <label class="col-form-label">مشتری:</label>
              <select id="AccountName" data-module="select2" name="AccountName"></select>
            </div>
            <div :class="['form-group mt-4', access?'hide':'']">
              <label class="col-form-label">نام مشتری:</label>
              <select id="AccountNumber" data-module="select2">
                <template v-if="accessData">
                  <option :value="accessData.AccountNumber">{{ accessData.AccountName }}</option>
                  <option :value="accessData.SAccountNumber">{{ accessData.SAccountName }}</option>
                  <option v-for="exAcc of accessData.ExAccounts" :value="exAcc.AccountNumber">{{ exAcc.AccountName }}</option>
                </template>
              </select>
            </div>
          </div>
        </div>
      </div>
      <div class="card-body p-0">
        <div class="card-scroll h-100">
          <b-skeleton-table v-if="loading.turnover" :rows="1" :columns="3" :table-props="{ bordered: true, striped: true }"></b-skeleton-table>
          <div v-else class="table-responsive">
            <table class="table table-hover">
              <thead>
              <tr>
                <th>شماره</th>
                <th>تاریخ</th>
                <th>شرح سند</th>
                <th>بدهکار</th>
                <th>بستانکار</th>
                <th>مانده نهایی</th>
                <th>تش</th>
                <th></th>
              </tr>
              </thead>
              <tbody>
              <tr v-for="(item, index) of trunover">
                <td>{{ item.DocNo }}</td>
                <td>{{ new Date(item.DocDate).echoFa("Y/m/d") }}</td>
                <td>{{ item.DocRowDesc }}</td>
                <td>{{ number_format(Math.trunc(item.RialBed)) }}</td>
                <td>{{ number_format(Math.trunc(item.RialBes)) }}</td>
                <td>{{ number_format(Math.trunc(Math.abs(item.total))) }}</td>
                <td>{{ item.total >= 0 ? 'بس' : 'بد' }}</td>
                <td><button v-if="item.InvTyp == 2 || item.InvTyp == 3" class="btn btn-xs btn-info" :data-invtype="item.InvTyp==2?'sale':'buy'" data-toggle="modal" :data-index="index" data-target="#showInv">مشاهده</button></td>
              </tr>
              <tr v-if="!trunover.length">
                <td class="text-center text-muted" colspan="7">--- هیچ موردی وجود ندارد ---</td>
              </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div v-if="!(access || accessData)" class="card">
      <div class="card-body">
        <div class="alert alert-danger alert-with-border m-b-0" role="alert">
          <h4 class="alert-heading">خطا!</h4>
          <p>متاسفانه در سیستم دسترسی مشاهده گردش حساب برای شما تعریف نگردیده است. لطفا با آقای رحمانی تماس حاصل فرمایید.</p>
        </div>
      </div>
    </div>
    <modal-inv :invHeaders="trunover" />
  </main>
</template>

<script>
import axios from "axios";
import util from "../../assets/pureFunctions";
import ModalInv from "../../components/ModalInv";
export default {
  data(){
    return {
      loading: {
        turnover: false
      },
      access: false,
      accessData: null,
      trunover: [],
      number_format: util.number_format
    }
  },
  methods: {
    getTurnover(id){
      this.loading.turnover = true;
      axios.post('/admin/accounting/getTurnover', {id}).then(({data}) => {
        if( data && data.ok ){
          this.trunover = data.list;
          this.$nextTick(function () {
            var ChatDiv = $('.card-scroll');
            var height = ChatDiv[0].scrollHeight;
            ChatDiv.scrollTop(height);
          });
        }else{
          toastr['error']("خطایی در بارگذاری اطلاعات رخ داده است.")
        }
        this.loading.turnover = false;
      });
    },
    getAccessData(){
      axios.post('/admin/accounting/accAccessList', {user: 1}).then(({data}) => {
        if( data.ok ){
          this.accessData = data.list.length > 0 ? data.list[0] : null;

          if( !this.access ){
            if( this.accessData ){
              this.getTurnover(this.accessData['AccountNumber'])
            }
          }

        }else{
          toastr['error']("خطا در خواندن سطح دسترسی.");
        }
      });
    }
  },
  created() {
    axios.post('/admin/access', {rule: ">/accounting/getTurnover;"}).then(({data}) => {
      if( data.ok ){
        this.access = data.access;
      }
    })
  },
  mounted() {
    const vm = this;
    this.getAccessData();

    $(document).ready(function(){
      $('#AccountName').select2({
        minimumInputLength: 1,
        ajax: {
          url: 'https://shygun.4mk.ir/api/customerName/search',
          type: "POST",
          dataType: 'json',
          data: function (params) {
            return {
              name: params.term
            };
          },
          processResults: function (data) {
            if (data.ok) {
              return {
                results: $.map(data.list, function (item) {
                  return {
                    text: item.AccountName,
                    id: item.AccountNumber
                  }
                })
              };
            } else {
              return {
                results: []
              };
            }
          }
        }
      });

      $('#AccountName').on('select2:select', function (e) {
        var data = e.params.data;
        vm.getTurnover(data.id);
      });

      $('#AccountNumber').on('select2:select', function (e) {
        var data = e.params.data;
        vm.getTurnover(data.id);
      });
    });
  },
  components: {
    'modal-inv' : ModalInv
  }
}
</script>

<style scoped>
.hide{display: none}
.full-height.fh-custom .card .card-body {height: calc(100vh - 245px);}
.btn-xs {padding: 2px 5px;font-size: 11px;height: 21px;}
</style>
